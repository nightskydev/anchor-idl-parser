import {
  PublicKey,
  TransactionInstruction,
  type AddressLookupTableAccount,
  type VersionedMessage,
} from "@solana/web3.js";

export type ProgramInstructionWithIndex = {
  /** Index in `message.compiledInstructions` */
  topLevelInstructionIndex: number;
  instruction: TransactionInstruction;
};

/**
 * Extract top-level instructions that invoke `programId` from a
 * {@link VersionedMessage}. Pure function: only `message` and optional
 * `addressLookupTableAccounts` (caller-supplied). No IDL loading, no transaction fetching.
 */
export function programInstructionsForProgramFromMessage(
  programId: PublicKey,
  message: VersionedMessage,
  addressLookupTableAccounts?: AddressLookupTableAccount[] | null
): ProgramInstructionWithIndex[] {
  const accountKeys = message.getAccountKeys({
    addressLookupTableAccounts:
      addressLookupTableAccounts && addressLookupTableAccounts.length > 0
        ? addressLookupTableAccounts
        : undefined,
  });

  const want = programId.toBase58();
  const out: ProgramInstructionWithIndex[] = [];

  message.compiledInstructions.forEach((ci, topLevelInstructionIndex) => {
    const pid = accountKeys.get(ci.programIdIndex);
    if (!pid || pid.toBase58() !== want) {
      return;
    }

    const keys = ci.accountKeyIndexes.map((idx) => {
      const pubkey = accountKeys.get(idx);
      if (!pubkey) {
        throw new Error(
          `Missing account at index ${idx} (resolved account list length ${accountKeys.length})`
        );
      }
      return {
        pubkey,
        isSigner: message.isAccountSigner(idx),
        isWritable: message.isAccountWritable(idx),
      };
    });

    out.push({
      topLevelInstructionIndex,
      instruction: new TransactionInstruction({
        programId: pid,
        keys,
        data: Buffer.from(ci.data),
      }),
    });
  });

  return out;
}
