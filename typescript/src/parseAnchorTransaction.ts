import type { Idl } from "@coral-xyz/anchor";
import type {
  AddressLookupTableAccount,
  TransactionInstruction,
  VersionedMessage,
} from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import {
  parseAnchorInstruction,
  type ParsedAnchorInstruction,
  type ParseAnchorInstructionOptions,
} from "./parseAnchorInstruction.js";
import { programInstructionsForProgramFromMessage } from "./programInstructionsFromMessage.js";

/**
 * Minimal transaction-shaped input: a {@link VersionedMessage} plus no other
 * requirements. Callers may build this from RPC responses, deserialized
 * ledger data, tests, or any other source — this type does not imply one.
 */
export type TransactionWithVersionedMessage = {
  readonly message: VersionedMessage;
};

export type ParsedAnchorInstructionInTransaction = {
  topLevelInstructionIndex: number;
  instruction: TransactionInstruction;
  parsed: ParsedAnchorInstruction | null;
};

/** Result of decoding all instructions in `transaction` that target `idl.address`. */
export type ParsedAnchorTransaction = {
  /** Same string as `idl.address` */
  programId: string;
  instructions: ParsedAnchorInstructionInTransaction[];
};

export type ParseAnchorTransactionOptions = {
  addressLookupTableAccounts?: AddressLookupTableAccount[] | null;
  parseInstruction?: ParseAnchorInstructionOptions;
};

/**
 * Abstract entry point: **in-memory** {@link Idl} + **in-memory** transaction
 * (`{ message }` — structurally compatible with `VersionedTransaction` and
 * with the `transaction` field of typical RPC transaction responses).
 *
 * **Returns** {@link ParsedAnchorTransaction} (program id + decoded instructions
 * for `idl.address`). Does not load the IDL, does not fetch the transaction,
 * and has no dependency on where either value originated.
 *
 * For v0 messages that use address lookup tables, supply pre-resolved tables
 * via `options.addressLookupTableAccounts` (resolution is a caller concern).
 */
export function parseAnchorTransaction(
  idl: Idl,
  transaction: TransactionWithVersionedMessage,
  options?: ParseAnchorTransactionOptions
): ParsedAnchorTransaction {
  const programId = new PublicKey(idl.address);
  const alts = options?.addressLookupTableAccounts;
  const parseOpts = options?.parseInstruction ?? {};

  const extracted = programInstructionsForProgramFromMessage(
    programId,
    transaction.message,
    alts
  );

  const instructions = extracted.map(({ topLevelInstructionIndex, instruction }) => ({
    topLevelInstructionIndex,
    instruction,
    parsed: parseAnchorInstruction(idl, instruction, parseOpts),
  }));

  return {
    programId: idl.address,
    instructions,
  };
}

/**
 * Same as {@link parseAnchorTransaction} but returns only the `instructions` array.
 */
export function parseAnchorInstructionsFromTransaction(
  idl: Idl,
  transaction: TransactionWithVersionedMessage,
  options?: ParseAnchorTransactionOptions
): ParsedAnchorInstructionInTransaction[] {
  return parseAnchorTransaction(idl, transaction, options).instructions;
}
