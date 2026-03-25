import {
  Connection,
  type AddressLookupTableAccount,
  PublicKey,
  TransactionInstruction,
  type VersionedMessage,
} from "@solana/web3.js";

/**
 * Load address lookup tables required for v0 messages.
 */
async function resolveAddressLookupTables(
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
 * Fetch a confirmed transaction and return every top-level instruction that
 * invokes `programId` (in order).
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
  const addressLookupTableAccounts = await resolveAddressLookupTables(
    connection,
    message
  );

  const accountKeys = message.getAccountKeys({
    addressLookupTableAccounts:
      addressLookupTableAccounts.length > 0
        ? addressLookupTableAccounts
        : undefined,
  });

  const want = programId.toBase58();
  const out: TransactionInstruction[] = [];

  for (const ci of message.compiledInstructions) {
    const pid = accountKeys.get(ci.programIdIndex);
    if (!pid || pid.toBase58() !== want) {
      continue;
    }

    const keys = ci.accountKeyIndexes.map((idx) => {
      const pubkey = accountKeys.get(idx);
      if (!pubkey) {
        throw new Error(`Missing account at index ${idx} in transaction ${signature}`);
      }
      return {
        pubkey,
        isSigner: message.isAccountSigner(idx),
        isWritable: message.isAccountWritable(idx),
      };
    });

    out.push(
      new TransactionInstruction({
        programId: pid,
        keys,
        data: Buffer.from(ci.data),
      })
    );
  }

  return out;
}
