/**
 * Single-instruction decode: in-memory {@link Idl} + {@link TransactionInstruction}.
 * For a full transaction body (`{ message }` or `VersionedTransaction`), use
 * {@link parseAnchorTransaction} instead. No I/O in this module.
 */

import { BorshInstructionCoder } from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";

type IdlInstructionAccountItem = Idl["instructions"][number]["accounts"][number];
type IdlType = Idl["instructions"][number]["args"][number]["type"];

/**
 * Flatten nested IDL account groups (same logic as Anchor's InstructionFormatter).
 */
function sentenceCase(field: string): string {
  const result = field.replace(/([A-Z])/g, " $1");
  return result.charAt(0).toUpperCase() + result.slice(1);
}

function flattenIdlAccounts(
  accounts: IdlInstructionAccountItem[],
  prefix?: string
): { name: string }[] {
  return accounts
    .map((account) => {
      const accName = sentenceCase(account.name);
      if ("accounts" in account && account.accounts) {
        const newPrefix = prefix ? `${prefix} > ${accName}` : accName;
        return flattenIdlAccounts(account.accounts, newPrefix);
      }
      return [
        {
          ...account,
          name: prefix ? `${prefix} > ${accName}` : accName,
        },
      ];
    })
    .flat();
}

export type ParsedAnchorAccount = {
  /** IDL account label, or undefined for remaining accounts beyond the IDL list */
  name: string | undefined;
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
};

export type ParsedAnchorInstruction = {
  /** Instruction method name (e.g. `initialize`) */
  name: string;
  /** Borsh-decoded argument object from the IDL layout */
  args: Record<string, unknown>;
  /** IDL arg field names and type strings (for display / tooling) */
  argSchema: { name: string; type: string }[];
  /** Program accounts with names aligned to `instruction.keys` order */
  accounts: ParsedAnchorAccount[];
  /** Whether `instruction.programId` equals `idl.address` */
  programIdMatches: boolean;
  /** Optional Anchor `format()` output: human-oriented string values per arg */
  formattedDisplay: {
    args: { name: string; type: string; data: string }[];
    accounts: {
      name?: string;
      pubkey: import("@solana/web3.js").PublicKey;
      isSigner: boolean;
      isWritable: boolean;
    }[];
  } | null;
};

export type ParseAnchorInstructionOptions = {
  /**
   * When true (default), require `instruction.programId` to match `idl.address`.
   * When false, still decode instruction data even if program IDs differ.
   */
  strictProgramId?: boolean;
};

/**
 * Parse an Anchor program instruction using an IDL: instruction name, decoded args,
 * and accounts labeled from the IDL.
 *
 * Relies on `@coral-xyz/anchor` {@link BorshInstructionCoder} (discriminator + Borsh).
 */
export function parseAnchorInstruction(
  idl: Idl,
  instruction: TransactionInstruction,
  options: ParseAnchorInstructionOptions = {}
): ParsedAnchorInstruction | null {
  const strictProgramId = options.strictProgramId ?? true;
  const programIdMatches =
    instruction.programId.toBase58() === idl.address;

  if (strictProgramId && !programIdMatches) {
    return null;
  }

  const coder = new BorshInstructionCoder(idl);
  const decoded = coder.decode(instruction.data);
  console.log({decoded, coder});
  if (!decoded) {
    return null;
  }

  const flatIdlAccounts = (() => {
    const idlIx = idl.instructions.find((i) => i.name === decoded.name);
    if (!idlIx) {
      return [];
    }
    return flattenIdlAccounts(idlIx.accounts);
  })();

  const accounts: ParsedAnchorAccount[] = instruction.keys.map((meta, idx) => {
    const label = flatIdlAccounts[idx];
    return {
      name: label?.name,
      pubkey: meta.pubkey.toBase58(),
      isSigner: meta.isSigner,
      isWritable: meta.isWritable,
    };
  });

  const idlIx = idl.instructions.find((i) => i.name === decoded.name);
  const argSchema =
    idlIx?.args.map((f) => ({
      name: f.name,
      type: formatIdlType(f.type),
    })) ?? [];

  const formattedDisplay = coder.format(decoded, instruction.keys);

  return {
    name: decoded.name,
    args: decoded.data as Record<string, unknown>,
    argSchema,
    accounts,
    programIdMatches,
    formattedDisplay,
  };
}

function formatIdlType(idlType: IdlType): string {
  if (typeof idlType === "string") {
    return idlType;
  }
  if ("option" in idlType) {
    return `Option<${formatIdlType(idlType.option)}>`;
  }
  if ("coption" in idlType) {
    return `COption<${formatIdlType(idlType.coption)}>`;
  }
  if ("vec" in idlType) {
    return `Vec<${formatIdlType(idlType.vec)}>`;
  }
  if ("array" in idlType) {
    return `Array<${idlType.array[0]}; ${idlType.array[1]}>`;
  }
  if ("defined" in idlType) {
    const name = idlType.defined.name;
    if (idlType.defined.generics?.length) {
      const generics = idlType.defined.generics
        .map((g: { kind: string; type?: IdlType; value?: string }) => {
          if (g.kind === "type" && g.type) {
            return formatIdlType(g.type);
          }
          return String(g.value);
        })
        .join(", ");
      return `${name}<${generics}>`;
    }
    return name;
  }
  if ("generic" in idlType) {
    return idlType.generic;
  }
  return "unknown";
}

/**
 * Produce a JSON-serializable snapshot (BN → decimal string, nested structs,
 * `formattedDisplay` pubkeys as base58).
 */
export function parsedInstructionToJsonSafe(
  parsed: ParsedAnchorInstruction | null
): Record<string, unknown> | null {
  if (parsed === null) {
    return null;
  }
  return {
    name: parsed.name,
    args: deepSerializeArgValues(parsed.args) as Record<string, unknown>,
    argSchema: parsed.argSchema,
    accounts: parsed.accounts,
    programIdMatches: parsed.programIdMatches,
    formattedDisplay: parsed.formattedDisplay
      ? {
          args: parsed.formattedDisplay.args,
          accounts: parsed.formattedDisplay.accounts.map((a) => ({
            name: a.name,
            pubkey: a.pubkey.toBase58(),
            isSigner: a.isSigner,
            isWritable: a.isWritable,
          })),
        }
      : null,
  };
}

function deepSerializeArgValues(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (BN.isBN(value)) {
    return value.toString(10);
  }
  if (value instanceof PublicKey) {
    return value.toBase58();
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return { __type: "Buffer", hex: value.toString("hex") };
  }
  if (value instanceof Uint8Array) {
    return { __type: "Uint8Array", hex: Buffer.from(value).toString("hex") };
  }
  if (Array.isArray(value)) {
    return value.map(deepSerializeArgValues);
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepSerializeArgValues(v);
    }
    return out;
  }
  return value;
}
