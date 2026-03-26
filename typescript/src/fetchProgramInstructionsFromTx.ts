import {
  Connection,
  type AddressLookupTableAccount,
  PublicKey,
  TransactionInstruction,
  type VersionedMessage,
} from "@solana/web3.js";
import { programInstructionsForProgramFromMessage } from "./programInstructionsFromMessage.js";

/**
 * Resolve address lookup tables for a v0 message via RPC (not used for legacy).
 */
export async function fetchAddressLookupTablesForMessage(
  connection: Connection,
  message: VersionedMessage
): Promise<AddressLookupTableAccount[]> {
  if (message.version === "legacy") {
    return [];
  }
  if (message.addressTableLookups.length === 0) {
    return [];
  }
  const results = await Promise.all(
    message.addressTableLookups.map((lookup) =>
      connection.getAddressLookupTable(lookup.accountKey)
    )
  );
  return results
    .map((res) => res.value)
    .filter((acc): acc is AddressLookupTableAccount => acc !== null);
}

/**
 * Fetch a confirmed transaction over RPC and return every top-level instruction
 * that invokes `programId` (in message order). For I/O-free parsing, use
 * {@link programInstructionsForProgramFromMessage} or
 * {@link parseAnchorTransaction} with data you already have.
 */
export async function fetchProgramInstructionsFromTx(
  connection: Connection,
  signature: string,
  programId: PublicKey
): Promise<TransactionInstruction[]> {
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });

  if (!tx?.transaction) {
    throw new Error(`Transaction not found or missing data: ${signature}`);
  }

  const { message } = tx.transaction;
  const addressLookupTableAccounts =
    await fetchAddressLookupTablesForMessage(connection, message);

  return programInstructionsForProgramFromMessage(
    programId,
    message,
    addressLookupTableAccounts
  ).map((x) => x.instruction);
}
