use crate::{
    Config, rpc,
    wallet::{amount, binding, field},
};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use zcash_payment_disclosure::{PaymentDisclosure, PaymentDisclosureProfile, verify_disclosure};
use zcash_proofs::prover::LocalTxProver;

pub async fn verify(config: &Config, input: &Value) -> Result<Value> {
    let offer = &input["offer"];
    ensure!(
        field(offer, "network")? == config.network
            && field(offer, "profile")? == "zally-ironwood-v1",
        "unsupported_profile"
    );
    let proof = &input["proof"];
    let bytes = hex::decode(field(proof, "disclosureHex")?)?;
    ensure!(bytes.len() <= 8000, "disclosure_too_large");
    let disclosure = PaymentDisclosure::from_bytes(&bytes)?;
    ensure!(
        disclosure.profile() == PaymentDisclosureProfile::ZallyIronwood
            && disclosure.message() == binding(offer)?,
        "disclosure_binding_mismatch"
    );
    let txid = field(proof, "txid")?;
    ensure!(
        disclosure.transaction_id().to_string() == txid,
        "transaction_mismatch"
    );
    let tx = rpc(config, "getrawtransaction", json!([txid, 1])).await?;
    let Some(blockhash) = tx["blockhash"].as_str() else {
        return Ok(json!({"chainPresent":false,"confirmations":0,"txid":txid}));
    };
    let block = rpc(config, "getblock", json!([blockhash, 1])).await?;
    let height: u32 = block["height"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("invalid_height"))?
        .try_into()?;
    ensure!(
        rpc(config, "getblockhash", json!([height])).await? == blockhash,
        "payment_reorged"
    );
    let info = rpc(config, "getblockchaininfo", json!([])).await?;
    let tip = info["blocks"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("invalid_tip"))?;
    ensure!(tip >= u64::from(height), "invalid_confirmation");
    let params = config.network()?.to_parameters();
    let prover = LocalTxProver::new(
        &config.params_dir.join("sapling-spend.params"),
        &config.params_dir.join("sapling-output.params"),
    );
    let (spend_vk, _) = prover.verifying_keys();
    let evidence = verify_disclosure(
        &disclosure,
        &hex::decode(field(&tx, "hex")?)?,
        zcash_protocol::consensus::BlockHeight::from_u32(height),
        &params,
        &spend_vk.prepare(),
    )?;
    let recipient = match zcash_keys::address::Address::decode(&params, field(offer, "payTo")?) {
        Some(zcash_keys::address::Address::Unified(ua)) => ua
            .orchard()
            .copied()
            .ok_or_else(|| anyhow::anyhow!("missing_receiver"))?,
        _ => anyhow::bail!("invalid_recipient"),
    };
    let outputs = evidence.ironwood_outputs();
    ensure!(
        outputs.len() == 1 && !evidence.ironwood_spends().is_empty(),
        "ambiguous_disclosure"
    );
    let output = &outputs[0];
    let memo = zcash_protocol::memo::MemoBytes::from_bytes(&binding(offer)?)?;
    ensure!(
        output.recipient() == recipient
            && output.amount_zat() == amount(field(offer, "amountZat")?)?
            && output.memo() == memo.as_array(),
        "payment_mismatch"
    );
    Ok(
        json!({"cryptographic":true,"memoMatch":true,"amountMatch":true,"recipientMatch":true,"chainPresent":true,"txid":txid,"outputIndex":output.index(),"confirmations":tip-u64::from(height)+1,"blockhash":blockhash,"height":height,"experimental":true}),
    )
}
