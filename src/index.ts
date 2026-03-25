/**
 * ## Pure API (no IDL/tx source — both must already be in memory)
 *
 * - {@link parseAnchorTransaction} — `(idl, transaction) → ParsedAnchorTransaction`
 * - {@link parseAnchorInstruction} — one `TransactionInstruction`
 * - {@link programInstructionsForProgramFromMessage} — extract program ixs from a message
 *
 * ## Optional Solana RPC helpers (separate concern)
 *
 * - {@link fetchProgramInstructionsFromTx}, {@link fetchAddressLookupTablesForMessage}
 */

export {
  parseAnchorInstruction,
  parsedInstructionToJsonSafe,
  type ParsedAnchorAccount,
  type ParsedAnchorInstruction,
  type ParseAnchorInstructionOptions,
} from "./parseAnchorInstruction.js";

export {
  parseAnchorTransaction,
  parseAnchorInstructionsFromTransaction,
  type ParsedAnchorInstructionInTransaction,
  type ParsedAnchorTransaction,
  type ParseAnchorTransactionOptions,
  type TransactionWithVersionedMessage,
} from "./parseAnchorTransaction.js";

export {
  programInstructionsForProgramFromMessage,
  type ProgramInstructionWithIndex,
} from "./programInstructionsFromMessage.js";

// Optional RPC helpers — not imported by parseAnchorTransaction / parseAnchorInstruction.
export {
  fetchAddressLookupTablesForMessage,
  fetchProgramInstructionsFromTx,
} from "./fetchProgramInstructionsFromTx.js";
