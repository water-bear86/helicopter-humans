mod verify;
mod wallet;

use anyhow::{Result, bail, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{self, Read},
    path::PathBuf,
};
use zally_core::Network;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub network: String,
    pub wallet_dir: PathBuf,
    pub zinder: String,
    pub zebra: String,
    pub params_dir: PathBuf,
    pub max_amount_zat: String,
    pub fee_cap_zat: String,
    pub budget_zat: String,
    pub merchants: BTreeMap<String, String>,
}
impl Config {
    pub fn network(&self) -> Result<Network> {
        match self.network.as_str() {
            "zcash:testnet" => Ok(Network::Testnet),
            "zcash:regtest" => {
                let one = Some(zcash_protocol::consensus::BlockHeight::from_u32(1));
                let two = Some(zcash_protocol::consensus::BlockHeight::from_u32(2));
                Ok(Network::Regtest(
                    zcash_protocol::local_consensus::LocalNetwork {
                        overwinter: one,
                        sapling: one,
                        blossom: one,
                        heartwood: one,
                        canopy: one,
                        nu5: two,
                        nu6: two,
                        nu6_1: two,
                        nu6_2: two,
                        nu6_3: two,
                    },
                ))
            }
            _ => bail!("unsupported_network"),
        }
    }
    fn validate(&self) -> Result<()> {
        self.network()?;
        ensure!(
            self.wallet_dir.is_absolute() && self.params_dir.is_absolute(),
            "absolute_paths_required"
        );
        for endpoint in [&self.zinder, &self.zebra] {
            let url = reqwest::Url::parse(endpoint)?;
            ensure!(
                url.scheme() == "http"
                    && matches!(url.host_str(), Some("127.0.0.1" | "[::1]"))
                    && url.username().is_empty()
                    && url.password().is_none(),
                "local_node_required"
            );
        }
        wallet::amount(&self.max_amount_zat)?;
        wallet::amount(&self.fee_cap_zat)?;
        wallet::amount(&self.budget_zat)?;
        Ok(())
    }
}

pub async fn rpc(config: &Config, method: &str, params: Value) -> Result<Value> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let response = client
        .post(&config.zebra)
        .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
        .send()
        .await?
        .error_for_status()?;
    ensure!(
        response.content_length().unwrap_or(0) <= 4_194_304,
        "node_response_too_large"
    );
    let bytes = response.bytes().await?;
    ensure!(bytes.len() <= 4_194_304, "node_response_too_large");
    let result: Value = serde_json::from_slice(&bytes)?;
    ensure!(result["error"].is_null(), "node_refused");
    Ok(result["result"].clone())
}

fn configure() -> Result<(Config, String)> {
    let args: Vec<String> = std::env::args().collect();
    ensure!(
        args.len() == 4 && args[1] == "--config",
        "usage: z402-wallet --config absolute.json command"
    );
    let config: Config = serde_json::from_slice(&std::fs::read(&args[2])?)?;
    config.validate()?;
    // Zally resolves proving parameters through XDG on macOS. Keep them in the
    // operator-selected directory instead of silently populating a home folder.
    #[cfg(target_os = "macos")]
    unsafe {
        std::env::set_var(
            "XDG_DATA_HOME",
            config
                .params_dir
                .parent()
                .ok_or_else(|| anyhow::anyhow!("invalid_params_directory"))?,
        );
    }
    #[cfg(target_os = "macos")]
    ensure!(
        config.params_dir.file_name().and_then(|name| name.to_str()) == Some("ZcashParams"),
        "params_directory_must_be_named_ZcashParams"
    );
    Ok((config, args[3].clone()))
}
async fn run(config: &Config, command: &str) -> Result<Value> {
    let mut input = Vec::new();
    io::stdin().take(4_194_305).read_to_end(&mut input)?;
    ensure!(input.len() <= 4_194_304, "input_too_large");
    let value: Value = if input.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&input)?
    };
    match command {
        "verify" => verify::verify(config, &value).await,
        "params" => {
            #[cfg(not(target_os = "macos"))]
            bail!("install_parameters_in_platform_default_location");
            #[cfg(target_os = "macos")]
            {
                zcash_proofs::download_sapling_parameters(Some(180))?;
                Ok(json!({"parametersReady":true}))
            }
        }
        command => wallet::command(config, command, &value).await,
    }
}
fn main() {
    // Configure parameter paths before creating any runtime worker threads.
    let result = configure().and_then(|(config, command)| {
        tokio::runtime::Runtime::new()?.block_on(run(&config, &command))
    });
    match result {
        Ok(result) => println!("{}", json!({"ok":true,"result":result})),
        Err(_) => {
            eprintln!(
                "native command refused; check local configuration, funds, chain readiness and proving parameters"
            );
            println!("{}", json!({"ok":false,"error":"native_refused"}));
            std::process::exit(1);
        }
    }
}
