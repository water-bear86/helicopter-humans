use crate::{Config, rpc};
use anyhow::{Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signature, VerifyingKey, pkcs8::DecodePublicKey};
use fs2::FileExt;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    time::{SystemTime, UNIX_EPOCH},
};
use zally_chain::{ChainSource, ShieldedPool, ZinderChainSource, ZinderRemoteOptions};
use zally_core::{BlockHeight, Memo, PaymentRecipient, TxId, Zatoshis};
use zally_keys::{AgeFileSealing, AgeFileSealingOptions};
use zally_pczt::PcztBytes;

type PurchaseRecord = (String, Option<Vec<u8>>, Option<Vec<u8>>, Option<u64>);
use zally_storage::{Sqlite, SqliteOptions};
use zally_wallet::{
    ExportPaymentDisclosurePlan, PaymentDisclosureProfile, ProposalPlan, ShieldTransparentPlan,
    Wallet,
};

pub fn canonical(value: &Value) -> Result<String> {
    // serde_json maps use sorted keys unless preserve_order is enabled.
    Ok(serde_json::to_string(value)?)
}

#[cfg(test)]
mod tests {
    use super::{amount, binding, canonical};
    use serde_json::json;

    #[test]
    fn amounts_are_exact_and_bounded() {
        assert_eq!(
            amount("2100000000000000").expect("maximum"),
            2_100_000_000_000_000
        );
        for invalid in ["-1", "1.5", "01", "1e5", "2100000000000001", ""] {
            assert!(amount(invalid).is_err());
        }
    }
    #[test]
    fn canonical_offer_binding_matches_node() {
        let value = json!({"b":2,"a":1});
        assert_eq!(canonical(&value).expect("canonical"), "{\"a\":1,\"b\":2}");
        assert_eq!(
            String::from_utf8(binding(&value).expect("binding")).expect("utf8"),
            "z402:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
        );
        assert_ne!(
            binding(&value).expect("binding"),
            binding(&json!({"a":2,"b":2})).expect("changed binding")
        );
    }
}
pub fn digest(value: &Value) -> Result<String> {
    Ok(hex::encode(Sha256::digest(canonical(value)?.as_bytes())))
}
pub fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value[name]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("invalid_field"))
}
pub fn amount(value: &str) -> Result<u64> {
    ensure!(
        !value.is_empty()
            && (value == "0" || !value.starts_with('0'))
            && value.bytes().all(|byte| byte.is_ascii_digit()),
        "invalid_amount"
    );
    let result = value.parse::<u64>()?;
    ensure!(result <= 2_100_000_000_000_000, "invalid_amount");
    Ok(result)
}
pub fn binding(offer: &Value) -> Result<Vec<u8>> {
    Ok(format!("z402:{}", digest(offer)?).into_bytes())
}
async fn sync_fully(wallet: &Wallet, chain: &ZinderChainSource) -> Result<()> {
    // Zally sync advances one bounded scan chunk. Do not report a backlog as synced.
    for _ in 0..512 {
        let outcome = wallet.sync(chain).await?;
        if outcome.block_count == 0 {
            return Ok(());
        }
    }
    bail!("wallet_sync_backlog_limit")
}
fn recipient(config: &Config, offer: &Value) -> Result<PaymentRecipient> {
    ensure!(
        field(offer, "network")? == config.network
            && field(offer, "profile")? == "zally-ironwood-v1",
        "unsupported_profile"
    );
    let encoded = field(offer, "payTo")?.to_owned();
    let decoded =
        zcash_keys::address::Address::decode(&config.network()?.to_parameters(), &encoded);
    ensure!(
        matches!(decoded, Some(zcash_keys::address::Address::Unified(ref ua)) if ua.orchard().is_some()),
        "shielded_recipient_required"
    );
    Ok(PaymentRecipient::UnifiedAddress {
        encoded,
        network: config.network()?,
    })
}
fn authorize(config: &Config, input: &Value) -> Result<(String, String, u64)> {
    let offer = &input["offer"];
    let fields = [
        "version",
        "id",
        "network",
        "asset",
        "amountZat",
        "feeCapZat",
        "payTo",
        "method",
        "url",
        "requestHash",
        "buyerKey",
        "responseKey",
        "createdAt",
        "expiresAt",
        "profile",
        "minimumConfirmations",
    ];
    ensure!(
        offer
            .as_object()
            .is_some_and(|value| value.len() == fields.len()
                && fields.iter().all(|field| value.contains_key(*field))),
        "invalid_offer_fields"
    );
    VerifyingKey::from_public_key_der(&STANDARD.decode(field(offer, "buyerKey")?)?)?;
    let response_key = STANDARD.decode(field(offer, "responseKey")?)?;
    ensure!(
        response_key.len() == 44 && response_key[..12] == hex::decode("302a300506032b656e032100")?,
        "invalid_response_key"
    );
    recipient(config, offer)?;
    let id = field(offer, "id")?.to_owned();
    ensure!(
        id.len() == 48
            && id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "invalid_purchase"
    );
    let created = offer["createdAt"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("invalid_expiry"))?;
    let expires = offer["expiresAt"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("invalid_expiry"))?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64;
    ensure!(
        created <= now + 30_000
            && expires > created
            && expires - created <= 3_600_000
            && expires <= 9_007_199_254_740_991,
        "invalid_expiry"
    );
    ensure!(
        offer["minimumConfirmations"]
            .as_u64()
            .is_some_and(|count| (1..=100).contains(&count)),
        "invalid_confirmations"
    );
    let url = reqwest::Url::parse(field(offer, "url")?)?;
    ensure!(
        offer["version"] == 1 && offer["asset"] == "ZEC" && offer["method"] == "GET",
        "invalid_offer"
    );
    ensure!(
        url.scheme() == "https"
            || (config.network == "zcash:regtest"
                && url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")),
        "invalid_resource"
    );
    ensure!(
        url.username().is_empty() && url.password().is_none() && url.fragment().is_none(),
        "invalid_resource"
    );
    let key = config
        .merchants
        .get(&url.origin().ascii_serialization())
        .ok_or_else(|| anyhow::anyhow!("merchant_not_allowed"))?;
    let verifying = VerifyingKey::from_public_key_der(&STANDARD.decode(key)?)?;
    let signature = Signature::from_slice(&STANDARD.decode(field(input, "offerSignature")?)?)?;
    verifying.verify_strict(
        format!("z402/private-purchase/v1/offer\n{}", canonical(offer)?).as_bytes(),
        &signature,
    )?;
    ensure!(
        offer["requestHash"] == digest(&json!({"method":"GET","url":field(offer,"url")?}))?,
        "resource_mismatch"
    );
    let price = amount(field(offer, "amountZat")?)?;
    let cap = amount(field(offer, "feeCapZat")?)?;
    ensure!(
        price > 0
            && price <= amount(&config.max_amount_zat)?
            && cap <= amount(&config.fee_cap_zat)?,
        "policy_refused"
    );
    Ok((
        id,
        digest(offer)?,
        price
            .checked_add(cap)
            .ok_or_else(|| anyhow::anyhow!("amount_overflow"))?,
    ))
}
fn protect_wallet_files(config: &Config) -> Result<()> {
    for name in ["seed.age", "seed.age.age-identity", "wallet.sqlite"] {
        let path = config.wallet_dir.join(name);
        if path.exists() {
            ensure!(fs::symlink_metadata(&path)?.is_file(), "unsafe_wallet_file");
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        }
    }
    Ok(())
}
fn fee(pczt: &PcztBytes) -> Result<u64> {
    let parsed = pczt.parse()?;
    ensure!(
        parsed.transparent().inputs().is_empty() && parsed.transparent().outputs().is_empty(),
        "transparent_payment_refused"
    );
    ensure!(
        parsed.sapling().spends().is_empty()
            && parsed.sapling().outputs().is_empty()
            && parsed.orchard().actions().is_empty(),
        "ironwood_only"
    );
    let (value, negative) = *parsed.ironwood().value_sum();
    ensure!(!negative, "invalid_fee");
    Ok(value)
}
fn store(config: &Config) -> Result<Connection> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&config.wallet_dir)?;
    let metadata = fs::symlink_metadata(&config.wallet_dir)?;
    ensure!(
        metadata.is_dir() && metadata.permissions().mode() & 0o077 == 0,
        "private_wallet_directory_required"
    );
    let path = config.wallet_dir.join("purchases.sqlite");
    if path.exists() {
        ensure!(
            !fs::symlink_metadata(&path)?.file_type().is_symlink(),
            "unsafe_journal"
        );
    }
    let db = Connection::open(&path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS purchases (id TEXT PRIMARY KEY, offer_hash TEXT NOT NULL, reserved INTEGER NOT NULL, unsigned BLOB, signed BLOB, fee INTEGER); CREATE TABLE IF NOT EXISTS policy (id INTEGER PRIMARY KEY, budget INTEGER NOT NULL);")?;
    let budget = amount(&config.budget_zat)?;
    db.execute("INSERT OR IGNORE INTO policy VALUES (1, ?)", [budget])?;
    ensure!(
        db.query_row("SELECT budget FROM policy WHERE id=1", [], |row| row
            .get::<_, u64>(0))?
            == budget,
        "budget_changed"
    );
    Ok(db)
}
fn builder(config: &Config) -> Result<zally_wallet::WalletBuilder<AgeFileSealing, Sqlite>> {
    Ok(Wallet::builder(
        config.network()?,
        AgeFileSealing::new(AgeFileSealingOptions::at_path(
            config.wallet_dir.join("seed.age"),
        )),
        Sqlite::new(SqliteOptions::for_network(
            config.network()?,
            config.wallet_dir.join("wallet.sqlite"),
        )),
    ))
}
pub async fn command(config: &Config, command: &str, input: &Value) -> Result<Value> {
    let mut db = store(config)?;
    protect_wallet_files(config)?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(config.wallet_dir.join("wallet.lock"))?;
    lock.try_lock_exclusive()?;
    let chain = ZinderChainSource::connect_remote(ZinderRemoteOptions {
        endpoint: config.zinder.clone(),
        network: config.network()?,
    })?;
    if command == "preflight" {
        let epoch = chain.current_epoch().await?;
        return Ok(
            json!({"network":config.network,"visibleHeight":u32::from(epoch.visible_tip().height),"experimental":true}),
        );
    }
    if command == "init" {
        ensure!(
            !config.wallet_dir.join("seed.age").exists(),
            "wallet_already_exists"
        );
        let birthday: u32 = if let Some(height) = input["birthdayHeight"].as_u64() {
            height.try_into()?
        } else {
            u32::from(chain.current_epoch().await?.visible_tip().height)
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("invalid_birthday"))?
        };
        let (wallet, account, _mnemonic) = builder(config)?
            .create(&chain, BlockHeight::from(birthday))
            .await?;
        protect_wallet_files(config)?;
        let address = wallet
            .derive_next_address(account)
            .await?
            .encode(&config.network()?.to_parameters());
        return Ok(json!({"address":address,"network":config.network}));
    }
    let (wallet, account) = builder(config)?.open().await?;
    match command {
        "regtest-funding-address" => {
            ensure!(config.network == "zcash:regtest", "regtest_only");
            let ua = wallet.derive_next_address_with_transparent(account).await?;
            let receiver = ua
                .transparent()
                .ok_or_else(|| anyhow::anyhow!("missing_transparent_receiver"))?;
            Ok(
                json!({"address":zcash_keys::address::Address::Transparent(*receiver).encode(&config.network()?.to_parameters())}),
            )
        }
        "regtest-shield" => {
            ensure!(config.network == "zcash:regtest", "regtest_only");
            sync_fully(&wallet, &chain).await?;
            wallet.refresh_transparent_utxos(&chain).await?;
            let submitter = chain.submitter();
            let result = wallet
                .shield_transparent_funds(
                    ShieldTransparentPlan::new(
                        account,
                        zally_core::IdempotencyKey::try_from(field(input, "id")?)?,
                        Zatoshis::try_from(100_000_000u64)?,
                        &submitter,
                    )
                    .with_destination_pool(ShieldedPool::Ironwood),
                )
                .await?;
            Ok(json!({"txid":result.broadcast.tx_id.to_rpc_hex()}))
        }
        "address" => Ok(
            json!({"address":wallet.derive_next_address(account).await?.encode(&config.network()?.to_parameters())}),
        ),
        "sync" => {
            sync_fully(&wallet, &chain).await?;
            Ok(json!({"synced":true}))
        }
        "propose" | "sign" | "submit" | "disclose" => {
            let (id, offer_hash, reserved) = authorize(config, input)?;
            if command == "propose" {
                let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                let existing: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM purchases WHERE id=?)",
                    [&id],
                    |row| row.get(0),
                )?;
                if !existing {
                    let used: u64 = tx.query_row(
                        "SELECT COALESCE(SUM(reserved),0) FROM purchases",
                        [],
                        |row| row.get(0),
                    )?;
                    ensure!(
                        used.checked_add(reserved)
                            .is_some_and(|total| total <= amount(&config.budget_zat).unwrap_or(0)),
                        "budget_exhausted"
                    );
                    tx.execute(
                        "INSERT OR IGNORE INTO purchases (id,offer_hash,reserved) VALUES (?,?,?)",
                        params![id, offer_hash, reserved],
                    )?;
                }
                tx.commit()?;
            }
            let (stored_hash, unsigned, signed, stored_fee): PurchaseRecord = db.query_row(
                "SELECT offer_hash,unsigned,signed,fee FROM purchases WHERE id=?",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            ensure!(stored_hash == offer_hash, "purchase_changed");
            if command == "propose" {
                if let Some(bytes) = unsigned {
                    return Ok(
                        json!({"pcztHex":hex::encode(bytes),"feeZat":stored_fee.ok_or_else(|| anyhow::anyhow!("missing_fee"))?.to_string()}),
                    );
                }
                let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64;
                ensure!(
                    input["offer"]["expiresAt"]
                        .as_u64()
                        .is_some_and(|expiry| expiry > now),
                    "quote_expired"
                );
                sync_fully(&wallet, &chain).await?;
                let memo = Memo::from_bytes(&binding(&input["offer"])?)?;
                let plan = ProposalPlan::conventional(
                    account,
                    recipient(config, &input["offer"])?,
                    Zatoshis::try_from(amount(field(&input["offer"], "amountZat")?)?)?,
                    Some(memo),
                )
                .with_source_pool(ShieldedPool::Ironwood);
                let proposal = wallet.propose_pczt(plan, None).await?;
                let fee_zat = fee(&proposal)?;
                if fee_zat > amount(field(&input["offer"], "feeCapZat")?)? {
                    wallet.abandon_pczt(&proposal).await?;
                    bail!("fee_cap_exceeded");
                }
                db.execute(
                    "UPDATE purchases SET unsigned=?,fee=?,reserved=? WHERE id=?",
                    params![
                        proposal.as_bytes(),
                        fee_zat,
                        amount(field(&input["offer"], "amountZat")?)? + fee_zat,
                        id
                    ],
                )?;
                return Ok(
                    json!({"pcztHex":hex::encode(proposal.as_bytes()),"feeZat":fee_zat.to_string()}),
                );
            }
            if command == "sign" {
                let supplied = hex::decode(field(input, "pcztHex")?)?;
                ensure!(unsigned.as_ref() == Some(&supplied), "proposal_changed");
                if let Some(bytes) = signed {
                    return Ok(
                        json!({"pcztHex":hex::encode(bytes),"feeZat":stored_fee.ok_or_else(|| anyhow::anyhow!("missing_fee"))?.to_string()}),
                    );
                }
                let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64;
                ensure!(
                    input["offer"]["expiresAt"]
                        .as_u64()
                        .is_some_and(|expiry| expiry > now),
                    "quote_expired"
                );
                let pczt = PcztBytes::from_serialized(supplied, config.network()?);
                let proven = wallet.prove_pczt(&pczt).await?;
                let authorized = wallet.sign_pczt(&proven).await?;
                db.execute(
                    "UPDATE purchases SET signed=? WHERE id=?",
                    params![authorized.as_bytes(), id],
                )?;
                return Ok(
                    json!({"pcztHex":hex::encode(authorized.as_bytes()),"feeZat":fee(&authorized)?.to_string()}),
                );
            }
            let signed = signed.ok_or_else(|| anyhow::anyhow!("purchase_not_signed"))?;
            if command == "submit" {
                ensure!(
                    hex::decode(field(input, "pcztHex")?)? == signed,
                    "signed_proposal_changed"
                );
            }
            let pczt = PcztBytes::from_serialized(signed.clone(), config.network()?);
            let txid = wallet.extract_pczt(&pczt).await?;
            if command == "submit" {
                let extracted = zally_pczt::Extractor::new().extract(pczt)?;
                // Broadcast the exact persisted transaction. Duplicate submission is safe.
                let response = rpc(
                    config,
                    "sendrawtransaction",
                    json!([hex::encode(extracted.raw_bytes)]),
                )
                .await;
                if response.is_err() {
                    rpc(config, "getrawtransaction", json!([txid.to_rpc_hex(), 0])).await?;
                }
                return Ok(json!({"txid":txid.to_rpc_hex()}));
            }
            ensure!(
                TxId::from_rpc_hex(field(input, "txid")?)? == txid,
                "transaction_changed"
            );
            let disclosure = wallet
                .export_payment_disclosure(ExportPaymentDisclosurePlan::new(
                    txid,
                    recipient(config, &input["offer"])?,
                    Zatoshis::try_from(amount(field(&input["offer"], "amountZat")?)?)?,
                    binding(&input["offer"])?,
                    PaymentDisclosureProfile::ZallyIronwood,
                ))
                .await?;
            Ok(json!({"disclosureHex":hex::encode(disclosure.to_bytes())}))
        }
        _ => bail!("unsupported_command"),
    }
}
