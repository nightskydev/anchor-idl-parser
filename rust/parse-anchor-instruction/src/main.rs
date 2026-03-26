//! CLI: parse Anchor instruction from JSON IDL + payload file (same shape as `scripts/*.payload.json`).
//!
//! Usage:
//!   parse-anchor-instruction <idl.json> <payload.json>
//!
//! Payload JSON fields (camelCase): `dataEncoding` (`hex`), `data`, `programId`, optional `strictProgramId` (default true), `accounts`.

use parse_anchor_instruction::{
    parse_anchor_instruction, AccountMetaInput, InstructionInput, ParseOptions,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PayloadJson {
    #[serde(default = "default_data_encoding")]
    data_encoding: String,
    data: String,
    program_id: String,
    #[serde(default = "default_strict_program_id")]
    strict_program_id: bool,
    accounts: Vec<AccountJson>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountJson {
    pubkey: String,
    is_signer: bool,
    is_writable: bool,
}

fn default_data_encoding() -> String {
    "hex".into()
}

fn default_strict_program_id() -> bool {
    true
}

fn decode_data(encoding: &str, data: &str) -> Result<Vec<u8>, String> {
    match encoding.to_ascii_lowercase().as_str() {
        "hex" => hex::decode(data.trim_start_matches("0x")).map_err(|e| e.to_string()),
        other => Err(format!("unsupported dataEncoding: {other} (only \"hex\" is supported)")),
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let idl_path = args
        .next()
        .ok_or_else(|| {
            "usage: parse-anchor-instruction <idl.json> <payload.json>".to_string()
        })?;
    let payload_path = args
        .next()
        .ok_or_else(|| {
            "usage: parse-anchor-instruction <idl.json> <payload.json>".to_string()
        })?;

    let idl_raw = std::fs::read_to_string(&idl_path)?;
    let idl: anchor_lang_idl_spec::Idl = serde_json::from_str(&idl_raw)?;

    let payload_raw = std::fs::read_to_string(&payload_path)?;
    let payload: PayloadJson = serde_json::from_str(&payload_raw)?;
    let data = decode_data(&payload.data_encoding, &payload.data)?;

    let ix = InstructionInput {
        program_id: payload.program_id,
        accounts: payload
            .accounts
            .into_iter()
            .map(|a| AccountMetaInput {
                pubkey: a.pubkey,
                is_signer: a.is_signer,
                is_writable: a.is_writable,
            })
            .collect(),
        data,
    };

    let options = ParseOptions {
        strict_program_id: payload.strict_program_id,
        ..Default::default()
    };

    let parsed = parse_anchor_instruction(&idl, &ix, options)?;
    println!("{}", serde_json::to_string_pretty(&parsed)?);
    Ok(())
}
