//! Parse an Anchor program instruction using a JSON IDL plus raw instruction bytes
//! and account metas — same role as `parseAnchorInstruction` in the TypeScript package.
//!
//! ```ignore
//! let idl: Idl = serde_json::from_str(idl_json)?;
//! let ix = InstructionInput { /* program_id, accounts, data */ };
//! let parsed = parse_anchor_instruction(&idl, &ix, ParseOptions::default())?;
//! ```

use anchor_lang_idl_spec::{
    Idl, IdlArrayLen, IdlDefinedFields, IdlInstructionAccountItem, IdlType, IdlTypeDef,
    IdlTypeDefTy,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use thiserror::Error;

/// Raw instruction input (no RPC): program id, account metas, data.
#[derive(Debug, Clone)]
pub struct InstructionInput {
    pub program_id: String,
    pub accounts: Vec<AccountMetaInput>,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct AccountMetaInput {
    pub pubkey: String,
    pub is_signer: bool,
    pub is_writable: bool,
}

#[derive(Debug, Clone)]
pub struct ParseOptions {
    /// When true (default), require `program_id` == `idl.address`.
    pub strict_program_id: bool,
}

impl Default for ParseOptions {
    fn default() -> Self {
        Self {
            strict_program_id: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ParsedAnchorAccount {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub pubkey: String,
    pub is_signer: bool,
    pub is_writable: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ArgSchemaEntry {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ParsedAnchorInstruction {
    pub name: String,
    /// JSON-friendly argument values (decimals for large integers where needed).
    pub args: serde_json::Map<String, serde_json::Value>,
    pub arg_schema: Vec<ArgSchemaEntry>,
    pub accounts: Vec<ParsedAnchorAccount>,
    pub program_id_matches: bool,
}

#[derive(Debug, Error)]
pub enum ParseError {
    #[error("program id mismatch (strict mode)")]
    ProgramIdMismatch,
    #[error("instruction data shorter than 8-byte discriminator")]
    DataTooShort,
    #[error("unknown instruction discriminator")]
    UnknownDiscriminator,
    #[error("IDL instruction not found after discriminator match: {0}")]
    InstructionNotFound(String),
    #[error("failed to decode instruction args: {0}")]
    ArgDecode(#[from] DecodeError),
}

#[derive(Debug, Error)]
pub enum DecodeError {
    #[error("unexpected end of data")]
    Eof,
    #[error("type not supported for decode: {0}")]
    UnsupportedType(String),
    #[error("undefined type: {0}")]
    UndefinedType(String),
    #[error("generic array length not supported: {0}")]
    GenericArrayLen(String),
    #[error("invalid enum variant index {0} (variant count {1})")]
    BadEnumVariant(u32, usize),
}

/// Match TypeScript `parseAnchorInstruction` (without `formattedDisplay`).
pub fn parse_anchor_instruction(
    idl: &Idl,
    ix: &InstructionInput,
    options: ParseOptions,
) -> Result<ParsedAnchorInstruction, ParseError> {
    let program_id_matches = ix.program_id == idl.address;
    if options.strict_program_id && !program_id_matches {
        return Err(ParseError::ProgramIdMismatch);
    }

    if ix.data.len() < 8 {
        return Err(ParseError::DataTooShort);
    }

    let disc = &ix.data[..8];
    let idl_ix = idl
        .instructions
        .iter()
        .find(|i| i.discriminator.as_slice() == disc)
        .ok_or(ParseError::UnknownDiscriminator)?;

    let name = idl_ix.name.clone();
    let rest = &ix.data[8..];

    let args_map = decode_instruction_args(rest, &idl_ix.args, &idl.types)?;
    let arg_schema = idl_ix
        .args
        .iter()
        .map(|f| ArgSchemaEntry {
            name: f.name.clone(),
            ty: format_idl_type(&f.ty),
        })
        .collect();

    let flat_accounts = flatten_idl_accounts(&idl_ix.accounts);
    let accounts: Vec<ParsedAnchorAccount> = ix
        .accounts
        .iter()
        .enumerate()
        .map(|(idx, m)| ParsedAnchorAccount {
            name: flat_accounts
                .get(idx)
                .map(|s| s.to_string()),
            pubkey: m.pubkey.clone(),
            is_signer: m.is_signer,
            is_writable: m.is_writable,
        })
        .collect();

    Ok(ParsedAnchorInstruction {
        name,
        args: args_map,
        arg_schema,
        accounts,
        program_id_matches,
    })
}

/// Anchor-style 8-byte discriminator: `sha256("global:" + name)[..8]`.
pub fn anchor_discriminator(name: &str) -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(format!("global:{name}").as_bytes());
    let full = hasher.finalize();
    full[..8].try_into().expect("8 bytes")
}

fn sentence_case(field: &str) -> String {
    let mut result = String::new();
    let mut chars = field.chars().peekable();
    while let Some(c) = chars.next() {
        if c.is_uppercase() && !result.is_empty() {
            result.push(' ');
        }
        if result.is_empty() {
            result.extend(c.to_uppercase());
        } else if result.ends_with(' ') {
            result.extend(c.to_uppercase());
        } else {
            result.push(c);
        }
    }
    result
}

fn flatten_idl_accounts(accounts: &[IdlInstructionAccountItem]) -> Vec<String> {
    fn walk(items: &[IdlInstructionAccountItem], prefix: Option<&str>) -> Vec<String> {
        let mut out = Vec::new();
        for item in items {
            match item {
                IdlInstructionAccountItem::Single(a) => {
                    let acc_name = sentence_case(&a.name);
                    let name = match prefix {
                        Some(p) => format!("{p} > {acc_name}"),
                        None => acc_name,
                    };
                    out.push(name);
                }
                IdlInstructionAccountItem::Composite(c) => {
                    let acc_name = sentence_case(&c.name);
                    let new_prefix = match prefix {
                        Some(p) => format!("{p} > {acc_name}"),
                        None => acc_name,
                    };
                    out.extend(walk(&c.accounts, Some(&new_prefix)));
                }
            }
        }
        out
    }
    walk(accounts, None)
}

fn typedef_map(types: &[IdlTypeDef]) -> HashMap<String, &IdlTypeDef> {
    types.iter().map(|t| (t.name.clone(), t)).collect()
}

fn decode_instruction_args(
    mut data: &[u8],
    fields: &[anchor_lang_idl_spec::IdlField],
    typedefs: &[IdlTypeDef],
) -> Result<serde_json::Map<String, serde_json::Value>, DecodeError> {
    let map = typedef_map(typedefs);
    let mut out = serde_json::Map::new();
    for f in fields {
        let v = decode_idl_type(&mut data, &f.ty, typedefs, &map)?;
        out.insert(f.name.clone(), v);
    }
    if !data.is_empty() {
        // Trailing bytes: still return partial decode (TS accepts extra? BorshInstructionCoder typically consumes all)
        // For strictness we could error — Anchor decoder usually fits exactly.
    }
    Ok(out)
}

fn read_u8(buf: &mut &[u8]) -> Result<u8, DecodeError> {
    if buf.is_empty() {
        return Err(DecodeError::Eof);
    }
    let x = buf[0];
    *buf = &buf[1..];
    Ok(x)
}

fn read_u32_le(buf: &mut &[u8]) -> Result<u32, DecodeError> {
    if buf.len() < 4 {
        return Err(DecodeError::Eof);
    }
    let x = u32::from_le_bytes(buf[..4].try_into().unwrap());
    *buf = &buf[4..];
    Ok(x)
}

fn read_u64_le(buf: &mut &[u8]) -> Result<u64, DecodeError> {
    if buf.len() < 8 {
        return Err(DecodeError::Eof);
    }
    let x = u64::from_le_bytes(buf[..8].try_into().unwrap());
    *buf = &buf[8..];
    Ok(x)
}

fn read_i64_le(buf: &mut &[u8]) -> Result<i64, DecodeError> {
    if buf.len() < 8 {
        return Err(DecodeError::Eof);
    }
    let x = i64::from_le_bytes(buf[..8].try_into().unwrap());
    *buf = &buf[8..];
    Ok(x)
}

fn read_u128_le(buf: &mut &[u8]) -> Result<u128, DecodeError> {
    if buf.len() < 16 {
        return Err(DecodeError::Eof);
    }
    let x = u128::from_le_bytes(buf[..16].try_into().unwrap());
    *buf = &buf[16..];
    Ok(x)
}

fn read_i128_le(buf: &mut &[u8]) -> Result<i128, DecodeError> {
    if buf.len() < 16 {
        return Err(DecodeError::Eof);
    }
    let x = i128::from_le_bytes(buf[..16].try_into().unwrap());
    *buf = &buf[16..];
    Ok(x)
}

fn decode_idl_type(
    buf: &mut &[u8],
    ty: &IdlType,
    typedefs: &[IdlTypeDef],
    map: &HashMap<String, &IdlTypeDef>,
) -> Result<serde_json::Value, DecodeError> {
    match ty {
        IdlType::Bool => Ok(serde_json::Value::Bool(read_u8(buf)? != 0)),
        IdlType::U8 => Ok(serde_json::Value::Number(read_u8(buf)?.into())),
        IdlType::I8 => Ok(serde_json::Value::Number((read_u8(buf)? as i8).into())),
        IdlType::U16 => {
            if buf.len() < 2 {
                return Err(DecodeError::Eof);
            }
            let x = u16::from_le_bytes(buf[..2].try_into().unwrap());
            *buf = &buf[2..];
            Ok(serde_json::Value::Number(x.into()))
        }
        IdlType::I16 => {
            if buf.len() < 2 {
                return Err(DecodeError::Eof);
            }
            let x = i16::from_le_bytes(buf[..2].try_into().unwrap());
            Ok(serde_json::Value::Number(x.into()))
        }
        IdlType::U32 => Ok(serde_json::Value::Number(read_u32_le(buf)?.into())),
        IdlType::I32 => {
            if buf.len() < 4 {
                return Err(DecodeError::Eof);
            }
            let x = i32::from_le_bytes(buf[..4].try_into().unwrap());
            *buf = &buf[4..];
            Ok(serde_json::Value::Number(x.into()))
        }
        IdlType::F32 => {
            if buf.len() < 4 {
                return Err(DecodeError::Eof);
            }
            let x = f32::from_le_bytes(buf[..4].try_into().unwrap());
            *buf = &buf[4..];
            serde_json::Number::from_f64(x as f64)
                .map(serde_json::Value::Number)
                .ok_or_else(|| DecodeError::UnsupportedType("f32 nan/inf".into()))
        }
        IdlType::U64 => {
            let n = read_u64_le(buf)?;
            Ok(serde_json::Value::String(n.to_string()))
        }
        IdlType::I64 => {
            let n = read_i64_le(buf)?;
            Ok(serde_json::Value::String(n.to_string()))
        }
        IdlType::F64 => {
            if buf.len() < 8 {
                return Err(DecodeError::Eof);
            }
            let x = f64::from_le_bytes(buf[..8].try_into().unwrap());
            *buf = &buf[8..];
            serde_json::Number::from_f64(x)
                .map(serde_json::Value::Number)
                .ok_or_else(|| DecodeError::UnsupportedType("f64 nan/inf".into()))
        }
        IdlType::U128 => {
            let n = read_u128_le(buf)?;
            Ok(serde_json::Value::String(n.to_string()))
        }
        IdlType::I128 => {
            let n = read_i128_le(buf)?;
            Ok(serde_json::Value::String(n.to_string()))
        }
        IdlType::U256 | IdlType::I256 => Err(DecodeError::UnsupportedType(
            "u256/i256 decode not implemented".into(),
        )),
        IdlType::Bytes => {
            let len = read_u32_le(buf)? as usize;
            if buf.len() < len {
                return Err(DecodeError::Eof);
            }
            let bytes = buf[..len].to_vec();
            *buf = &buf[len..];
            Ok(serde_json::Value::String(hex::encode(bytes)))
        }
        IdlType::String => {
            let len = read_u32_le(buf)? as usize;
            if buf.len() < len {
                return Err(DecodeError::Eof);
            }
            let s = std::str::from_utf8(&buf[..len])
                .map_err(|_| DecodeError::UnsupportedType("invalid utf-8".into()))?
                .to_string();
            *buf = &buf[len..];
            Ok(serde_json::Value::String(s))
        }
        IdlType::Pubkey => {
            if buf.len() < 32 {
                return Err(DecodeError::Eof);
            }
            let pk = bs58::encode(&buf[..32]).into_string();
            *buf = &buf[32..];
            Ok(serde_json::Value::String(pk))
        }
        IdlType::Option(inner) => {
            let tag = read_u8(buf)?;
            if tag == 0 {
                Ok(serde_json::Value::Null)
            } else {
                decode_idl_type(buf, inner, typedefs, map)
            }
        }
        IdlType::Vec(inner) => {
            let len = read_u32_le(buf)? as usize;
            let mut arr = Vec::with_capacity(len);
            for _ in 0..len {
                arr.push(decode_idl_type(buf, inner, typedefs, map)?);
            }
            Ok(serde_json::Value::Array(arr))
        }
        IdlType::Array(inner, alen) => {
            let n = match alen {
                IdlArrayLen::Value(n) => *n,
                IdlArrayLen::Generic(g) => {
                    return Err(DecodeError::GenericArrayLen(g.clone()));
                }
            };
            let mut arr = Vec::with_capacity(n);
            for _ in 0..n {
                arr.push(decode_idl_type(buf, inner, typedefs, map)?);
            }
            Ok(serde_json::Value::Array(arr))
        }
        IdlType::Defined { name, .. } => {
            let def = map
                .get(name)
                .ok_or_else(|| DecodeError::UndefinedType(name.clone()))?;
            decode_defined(buf, def, typedefs, map)
        }
        IdlType::Generic(_) => Err(DecodeError::UnsupportedType("generic type".into())),
        #[allow(unreachable_patterns)]
        _ => Err(DecodeError::UnsupportedType(
            "idl type variant not handled (spec extended)".into(),
        )),
    }
}

fn decode_defined(
    buf: &mut &[u8],
    def: &IdlTypeDef,
    typedefs: &[IdlTypeDef],
    map: &HashMap<String, &IdlTypeDef>,
) -> Result<serde_json::Value, DecodeError> {
    match &def.ty {
        IdlTypeDefTy::Struct { fields } => {
            let Some(fields) = fields else {
                return Ok(serde_json::Value::Object(serde_json::Map::new()));
            };
            match fields {
                IdlDefinedFields::Named(named) => {
                    let mut obj = serde_json::Map::new();
                    for f in named {
                        let v = decode_idl_type(buf, &f.ty, typedefs, map)?;
                        obj.insert(f.name.clone(), v);
                    }
                    Ok(serde_json::Value::Object(obj))
                }
                IdlDefinedFields::Tuple(types) => {
                    let mut arr = Vec::with_capacity(types.len());
                    for t in types {
                        arr.push(decode_idl_type(buf, t, typedefs, map)?);
                    }
                    Ok(serde_json::Value::Array(arr))
                }
            }
        }
        IdlTypeDefTy::Enum { variants } => {
            let discriminant = read_u32_le(buf)?;
            let variant = variants
                .get(discriminant as usize)
                .ok_or(DecodeError::BadEnumVariant(discriminant, variants.len()))?;
            let variant_name = variant.name.clone();
            let value = match &variant.fields {
                None => serde_json::Value::Null,
                Some(IdlDefinedFields::Named(named)) => {
                    let mut obj = serde_json::Map::new();
                    for f in named {
                        let v = decode_idl_type(buf, &f.ty, typedefs, map)?;
                        obj.insert(f.name.clone(), v);
                    }
                    serde_json::Value::Object(obj)
                }
                Some(IdlDefinedFields::Tuple(types)) => {
                    let mut arr = Vec::with_capacity(types.len());
                    for t in types {
                        arr.push(decode_idl_type(buf, t, typedefs, map)?);
                    }
                    serde_json::Value::Array(arr)
                }
            };
            let mut obj = serde_json::Map::new();
            obj.insert(
                variant_name,
                value,
            );
            Ok(serde_json::Value::Object(obj))
        }
        IdlTypeDefTy::Type { alias } => decode_idl_type(buf, alias, typedefs, map),
    }
}

fn format_idl_type(ty: &IdlType) -> String {
    match ty {
        IdlType::Bool => "bool".into(),
        IdlType::U8 => "u8".into(),
        IdlType::I8 => "i8".into(),
        IdlType::U16 => "u16".into(),
        IdlType::I16 => "i16".into(),
        IdlType::U32 => "u32".into(),
        IdlType::I32 => "i32".into(),
        IdlType::F32 => "f32".into(),
        IdlType::U64 => "u64".into(),
        IdlType::I64 => "i64".into(),
        IdlType::F64 => "f64".into(),
        IdlType::U128 => "u128".into(),
        IdlType::I128 => "i128".into(),
        IdlType::U256 => "u256".into(),
        IdlType::I256 => "i256".into(),
        IdlType::Bytes => "bytes".into(),
        IdlType::String => "string".into(),
        IdlType::Pubkey => "pubkey".into(),
        IdlType::Option(inner) => format!("Option<{}>", format_idl_type(inner)),
        IdlType::Vec(inner) => format!("Vec<{}>", format_idl_type(inner)),
        IdlType::Array(inner, IdlArrayLen::Value(n)) => {
            format!("[{}; {}]", format_idl_type(inner), n)
        }
        IdlType::Array(inner, IdlArrayLen::Generic(g)) => {
            format!("[{}; {}]", format_idl_type(inner), g)
        }
        IdlType::Defined { name, generics } if generics.is_empty() => name.clone(),
        IdlType::Defined { name, generics } => {
            let g = generics
                .iter()
                .map(|ga| match ga {
                    anchor_lang_idl_spec::IdlGenericArg::Type { ty } => format_idl_type(ty),
                    anchor_lang_idl_spec::IdlGenericArg::Const { value } => value.clone(),
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("{name}<{g}>")
        }
        IdlType::Generic(s) => s.clone(),
        #[allow(unreachable_patterns)]
        _ => "unknown".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang_idl_spec::{
        IdlField, IdlInstruction, IdlInstructionAccount, IdlInstructionAccountItem, IdlMetadata,
    };
    use borsh::BorshSerialize;
    use solana_keypair::Keypair;
    use solana_pubkey::Pubkey;
    use solana_signer::Signer;

    fn build_test_idl(program: Pubkey) -> Idl {
        Idl {
            address: program.to_string(),
            metadata: IdlMetadata {
                name: "test_program".into(),
                version: "0.1.0".into(),
                spec: "0.1.0".into(),
                description: None,
                repository: None,
                dependencies: vec![],
                contact: None,
                deployments: None,
            },
            docs: vec![],
            instructions: vec![
                IdlInstruction {
                    name: "initialize".into(),
                    docs: vec![],
                    discriminator: anchor_discriminator("initialize").to_vec(),
                    accounts: vec![
                        IdlInstructionAccountItem::Single(IdlInstructionAccount {
                            name: "authority".into(),
                            docs: vec![],
                            writable: true,
                            signer: true,
                            optional: false,
                            address: None,
                            pda: None,
                            relations: vec![],
                        }),
                        IdlInstructionAccountItem::Single(IdlInstructionAccount {
                            name: "vault".into(),
                            docs: vec![],
                            writable: true,
                            signer: false,
                            optional: false,
                            address: None,
                            pda: None,
                            relations: vec![],
                        }),
                    ],
                    args: vec![IdlField {
                        name: "amount".into(),
                        docs: vec![],
                        ty: IdlType::U64,
                    }],
                    returns: None,
                },
                IdlInstruction {
                    name: "ping".into(),
                    docs: vec![],
                    discriminator: anchor_discriminator("ping").to_vec(),
                    accounts: vec![IdlInstructionAccountItem::Single(IdlInstructionAccount {
                        name: "signer".into(),
                        docs: vec![],
                        writable: true,
                        signer: true,
                        optional: false,
                        address: None,
                        pda: None,
                        relations: vec![],
                    })],
                    args: vec![],
                    returns: None,
                },
            ],
            accounts: vec![],
            events: vec![],
            errors: vec![],
            types: vec![],
            constants: vec![],
        }
    }

    #[derive(BorshSerialize)]
    struct InitializeArgs {
        amount: u64,
    }

    #[test]
    fn parses_idl_and_instruction_like_typescript_test() {
        let program = Keypair::new().pubkey();
        let idl = build_test_idl(program);
        let authority = Keypair::new().pubkey();
        let vault = Keypair::new().pubkey();

        let mut data = anchor_discriminator("initialize").to_vec();
        InitializeArgs { amount: 9_876_543_210 }
            .serialize(&mut data)
            .unwrap();

        let ix = InstructionInput {
            program_id: program.to_string(),
            accounts: vec![
                AccountMetaInput {
                    pubkey: authority.to_string(),
                    is_signer: true,
                    is_writable: true,
                },
                AccountMetaInput {
                    pubkey: vault.to_string(),
                    is_signer: false,
                    is_writable: true,
                },
            ],
            data,
        };

        let parsed = parse_anchor_instruction(&idl, &ix, ParseOptions::default()).unwrap();
        assert_eq!(parsed.name, "initialize");
        assert!(parsed.program_id_matches);
        assert_eq!(
            parsed.arg_schema,
            vec![ArgSchemaEntry {
                name: "amount".into(),
                ty: "u64".into(),
            }]
        );
        assert_eq!(
            parsed.args.get("amount").and_then(|v| v.as_str()),
            Some("9876543210")
        );
        assert_eq!(parsed.accounts.len(), 2);
        assert_eq!(parsed.accounts[0].name.as_deref(), Some("Authority"));
        assert_eq!(parsed.accounts[0].pubkey, authority.to_string());
        assert_eq!(parsed.accounts[1].name.as_deref(), Some("Vault"));
    }

    #[test]
    fn ping_has_no_args() {
        let program = Keypair::new().pubkey();
        let idl = build_test_idl(program);
        let signer = Keypair::new().pubkey();
        let data = anchor_discriminator("ping").to_vec();
        let ix = InstructionInput {
            program_id: program.to_string(),
            accounts: vec![AccountMetaInput {
                pubkey: signer.to_string(),
                is_signer: true,
                is_writable: true,
            }],
            data,
        };
        let parsed = parse_anchor_instruction(&idl, &ix, ParseOptions::default()).unwrap();
        assert_eq!(parsed.name, "ping");
        assert!(parsed.args.is_empty());
        assert_eq!(parsed.accounts[0].name.as_deref(), Some("Signer"));
    }

    #[test]
    fn strict_program_id_rejects_mismatch() {
        let program = Keypair::new().pubkey();
        let other = Keypair::new().pubkey();
        let idl = build_test_idl(program);
        let mut data = anchor_discriminator("initialize").to_vec();
        InitializeArgs { amount: 1 }.serialize(&mut data).unwrap();
        let ix = InstructionInput {
            program_id: other.to_string(),
            accounts: vec![],
            data,
        };
        let err = parse_anchor_instruction(&idl, &ix, ParseOptions::default()).unwrap_err();
        assert!(matches!(err, ParseError::ProgramIdMismatch));
    }

    /// Ensure JSON IDL from disk deserializes (same file shape as Anchor CLI / TS).
    #[test]
    fn deserialize_mytest_json_idl() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../typescript/mytest.json");
        let raw = std::fs::read_to_string(path).expect("read mytest.json");
        let idl: Idl = serde_json::from_str(&raw).expect("idl json");
        assert!(!idl.instructions.is_empty());
    }

    /// Real IDL: `set_fee` args admin_fee=100, resolver_fee=200 (hex from Anchor TS coder).
    #[test]
    fn decodes_set_fee_from_checkin_idl() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../typescript/mytest.json");
        let raw = std::fs::read_to_string(path).expect("read mytest.json");
        let idl: Idl = serde_json::from_str(&raw).expect("idl json");
        let hex = "129a1812edd613506400000000000000c800000000000000";
        let data: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect();
        let ix = InstructionInput {
            program_id: idl.address.clone(),
            accounts: vec![
                AccountMetaInput {
                    pubkey: "9Pz3Lx8BovRsw3xzs9TiDxqatHZcnBfvx5EPFz2tSyP".into(),
                    is_signer: true,
                    is_writable: true,
                },
                AccountMetaInput {
                    pubkey: "Hog7rUASGua1nUWzsMnNG9P9ScAh35fyfU2bzPZ6SVyW".into(),
                    is_signer: false,
                    is_writable: true,
                },
            ],
            data,
        };
        let parsed = parse_anchor_instruction(&idl, &ix, ParseOptions::default()).unwrap();
        assert_eq!(parsed.name, "set_fee");
        assert_eq!(
            parsed.args.get("admin_fee").and_then(|v| v.as_str()),
            Some("100")
        );
        assert_eq!(
            parsed.args.get("resolver_fee").and_then(|v| v.as_str()),
            Some("200")
        );
        assert_eq!(parsed.accounts[0].name.as_deref(), Some("Admin1"));
    }
}
