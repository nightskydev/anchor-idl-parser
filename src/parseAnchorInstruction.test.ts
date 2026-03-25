import { createHash } from "node:crypto";
import { BorshInstructionCoder } from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { describe, expect, it } from "vitest";
import {
  parseAnchorInstruction,
  parsedInstructionToJsonSafe,
} from "./parseAnchorInstruction";

/**
 * Anchor-style discriminator: first 8 bytes of sha256("global:<name>").
 */
function anchorDiscriminator(name: string): number[] {
  const hash = createHash("sha256").update(`global:${name}`).digest();
  return [...hash.subarray(0, 8)];
}

/** In-memory IDL only; no dependency on any checked-in *.json program. */
function buildTestIdl(programId: PublicKey): Idl {
  return {
    address: programId.toBase58(),
    metadata: {
      name: "test_program",
      version: "0.1.0",
      spec: "0.1.0",
    },
    instructions: [
      {
        name: "initialize",
        discriminator: anchorDiscriminator("initialize"),
        accounts: [
          { name: "authority", signer: true, writable: true },
          { name: "vault", writable: true },
        ],
        args: [{ name: "amount", type: "u64" }],
      },
      {
        name: "ping",
        discriminator: anchorDiscriminator("ping"),
        accounts: [{ name: "signer", signer: true, writable: true }],
        args: [],
      },
    ],
  };
}

describe("parseAnchorInstruction", () => {
  it("parses IDL + instruction into name, args, and labeled accounts", () => {
    const program = Keypair.generate();
    const idl = buildTestIdl(program.publicKey);
    const coder = new BorshInstructionCoder(idl);

    const authority = Keypair.generate();
    const vault = Keypair.generate();
    const amount = new BN("9876543210");

    const data = coder.encode("initialize", { amount });

    const ix = new TransactionInstruction({
      programId: program.publicKey,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: vault.publicKey, isSigner: false, isWritable: true },
      ],
      data,
    });

    const parsed = parseAnchorInstruction(idl, ix);
    expect(parsed).not.toBeNull();
    if (!parsed) {
      return;
    }

    expect(parsed.name).toBe("initialize");
    expect(parsed.programIdMatches).toBe(true);
    expect(parsed.argSchema).toEqual([{ name: "amount", type: "u64" }]);

    const amt = parsed.args.amount;
    expect(BN.isBN(amt)).toBe(true);
    expect((amt as BN).toString()).toBe("9876543210");

    expect(parsed.accounts).toHaveLength(2);
    expect(parsed.accounts[0]).toMatchObject({
      name: "Authority",
      pubkey: authority.publicKey.toBase58(),
      isSigner: true,
      isWritable: true,
    });
    expect(parsed.accounts[1]).toMatchObject({
      name: "Vault",
      pubkey: vault.publicKey.toBase58(),
      isSigner: false,
      isWritable: true,
    });

    expect(parsed.formattedDisplay?.args[0]).toMatchObject({
      name: "amount",
      type: "u64",
    });
  });

  it("parses instruction with zero args (discriminator only)", () => {
    const program = Keypair.generate();
    const idl = buildTestIdl(program.publicKey);
    const coder = new BorshInstructionCoder(idl);
    const signer = Keypair.generate();
    const data = coder.encode("ping", {});
    const ix = new TransactionInstruction({
      programId: program.publicKey,
      keys: [{ pubkey: signer.publicKey, isSigner: true, isWritable: true }],
      data,
    });
    const parsed = parseAnchorInstruction(idl, ix);
    expect(parsed?.name).toBe("ping");
    expect(parsed?.argSchema).toEqual([]);
    expect(parsed?.accounts[0]?.name).toBe("Signer");
  });

  it("returns null when program id does not match IDL (strict default)", () => {
    const program = Keypair.generate();
    const other = Keypair.generate();
    const idl = buildTestIdl(program.publicKey);
    const coder = new BorshInstructionCoder(idl);

    const data = coder.encode("initialize", { amount: new BN(1) });
    const ix = new TransactionInstruction({
      programId: other.publicKey,
      keys: [],
      data,
    });

    expect(parseAnchorInstruction(idl, ix)).toBeNull();
  });

  it("returns null when instruction data does not match any discriminator", () => {
    const program = Keypair.generate();
    const idl = buildTestIdl(program.publicKey);
    const ix = new TransactionInstruction({
      programId: program.publicKey,
      keys: [],
      data: Buffer.alloc(32, 0xff),
    });

    expect(parseAnchorInstruction(idl, ix)).toBeNull();
  });
});
