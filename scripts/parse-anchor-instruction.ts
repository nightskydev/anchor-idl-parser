/**
 * Generic CLI: decode one Anchor instruction using any Anchor JSON IDL.
 *
 * From a transaction:
 *   npx tsx scripts/parse-anchor-instruction.ts <idl.json> --signature <BASE58_TX_SIG> \
 *     [--rpc https://api.devnet.solana.com] [--ix-index 0]
 *   Default RPC: https://api.devnet.solana.com or env SOLANA_RPC_URL
 *
 * From a payload file / stdin (you author payload; no IDL baked into this repo):
 *   npx tsx scripts/parse-anchor-instruction.ts <idl.json> --file payload.json
 *   cat payload.json | npx tsx scripts/parse-anchor-instruction.ts <idl.json>
 *
 * Payload JSON (file or stdin):
 * {
 *   "data": "<hex or base58>",
 *   "dataEncoding": "hex" | "base58",
 *   "programId": "<optional>",
 *   "accounts": [ { "pubkey": "...", "isSigner": true, "isWritable": true } ],
 *   "strictProgramId": true
 * }
 *
 * Prints JSON: input, output (or null + error on failure).
 *
 * Save JSON to a file:
 *   ... --out ./report.json   (alias: --output)
 *
 * Quick help:
 *   npm run parse-instruction -- --help
 */

import { readFileSync, writeFileSync } from "node:fs";
import { isatty } from "node:tty";
import { resolve } from "node:path";
import type { Idl } from "@coral-xyz/anchor";
import bs58 from "bs58";
import {
  Connection,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { fetchProgramInstructionsFromTx } from "../src/fetchProgramInstructionsFromTx";
import {
  parseAnchorInstruction,
  parsedInstructionToJsonSafe,
} from "../src/parseAnchorInstruction";

type Payload = {
  data: string;
  dataEncoding?: "hex" | "base58";
  programId?: string;
  accounts: Array<{
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>;
  strictProgramId?: boolean;
};

function getFlagValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) {
    return undefined;
  }
  const v = process.argv[i + 1];
  if (v.startsWith("-")) {
    return undefined;
  }
  return v;
}

function loadPayload(): { payload: Payload; payloadSource: string } {
  const fileIdx = process.argv.indexOf("--file");
  if (fileIdx !== -1 && process.argv[fileIdx + 1]) {
    const pathAbs = resolve(process.cwd(), process.argv[fileIdx + 1]);
    const raw = readFileSync(pathAbs, "utf8");
    return { payload: JSON.parse(raw) as Payload, payloadSource: pathAbs };
  }
  if (isatty(0)) {
    console.error(
      "Use --file payload.json or pipe JSON to stdin (non-interactive).\n\n" +
        "Example payload:\n" +
        JSON.stringify(
          {
            dataEncoding: "hex",
            data: "…instruction bytes as hex…",
            accounts: [
              {
                pubkey: "…",
                isSigner: true,
                isWritable: true,
              },
            ],
          },
          null,
          2
        )
    );
    process.exit(1);
  }
  const stdin = readFileSync(0, "utf8").trim();
  if (!stdin) {
    console.error("Empty stdin.");
    process.exit(1);
  }
  return { payload: JSON.parse(stdin) as Payload, payloadSource: "<stdin>" };
}

function printHelp(): void {
  console.log(`
Anchor IDL instruction decoder — pass YOUR idl.json; nothing is hardcoded.

┌─ From a chain transaction (easiest if you have a tx signature)
│  npm run parse-instruction -- ./your.idl.json --signature <BASE58_TX_SIGNATURE>
│  npm run parse-instruction -- ./your.idl.json --signature <SIG> --rpc https://api.devnet.solana.com
│  npm run parse-instruction -- ./your.idl.json --signature <SIG> --ix-index 1
│  (add --out ./report.json on any command to write the JSON result to disk)
│
│  Default RPC: https://api.devnet.solana.com  (or set SOLANA_RPC_URL)
│
├─ From raw instruction bytes + account list (payload JSON)
│  npm run parse-instruction -- ./your.idl.json --file ./my_payload.json --out ./report.json
│  cat my_payload.json | npm run parse-instruction -- ./your.idl.json --out ./report.json
│
│  Copy scripts/payload.example.json → edit with real data from explorer/SDK.
│  "data" = instruction data only (hex or base58 per dataEncoding).
│  "accounts" = same order as in the transaction instruction.
│
└─ In TypeScript (your app)
   import idl from "./your.idl.json";
   import { parseAnchorInstruction } from "./src/parseAnchorInstruction";
   parseAnchorInstruction(idl as Idl, transactionInstruction);

Run unit tests: npm test
`);
}

function decodeData(data: string, encoding: "hex" | "base58"): Buffer {
  if (encoding === "base58") {
    return Buffer.from(bs58.decode(data));
  }
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  return Buffer.from(hex, "hex");
}

function instructionToReport(
  ix: TransactionInstruction,
  idl: Idl,
  strictProgramId: boolean,
  dataEncoding: string
) {
  return {
    programId: ix.programId.toBase58(),
    programIdMatchesIdl: ix.programId.toBase58() === idl.address,
    strictProgramId,
    dataEncoding,
    dataLengthBytes: ix.data.length,
    dataHex: ix.data.toString("hex"),
    accountCount: ix.keys.length,
    accounts: ix.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
  };
}

function emitReport(
  input: Record<string, unknown>,
  parsed: ReturnType<typeof parseAnchorInstruction>,
  outPath: string | undefined
): never {
  const errMsg =
    "Decode failed (wrong discriminator, program id mismatch with strictProgramId, or unknown instruction).";

  const body =
    parsed === null
      ? { input, output: null, error: errMsg }
      : { input, output: parsedInstructionToJsonSafe(parsed) };

  const text = JSON.stringify(body, null, 2);

  if (outPath) {
    const abs = resolve(process.cwd(), outPath);
    writeFileSync(abs, text, "utf8");
    console.error(`Wrote ${abs}`);
  } else {
    console.log(text);
  }

  if (parsed === null) {
    console.error(errMsg);
    process.exit(1);
  }

  process.exit(0);
}

async function main(): Promise<void> {
  const first = process.argv[2];
  if (first === "--help" || first === "-h") {
    printHelp();
    process.exit(0);
  }

  const idlPath = first;
  if (!idlPath || idlPath.startsWith("-")) {
    console.error(
      "Missing <idl.json>. Run: npm run parse-instruction -- --help\n"
    );
    process.exit(1);
  }

  const idlResolved = resolve(process.cwd(), idlPath);
  const idl = JSON.parse(readFileSync(idlResolved, "utf8")) as Idl;

  const outPath = getFlagValue("--out") ?? getFlagValue("--output");

  const idlSummary = {
    address: idl.address,
    name: idl.metadata?.name,
    version: idl.metadata?.version,
    instructionNames: idl.instructions.map((ixn) => ixn.name),
  };

  const signature = getFlagValue("--signature");

  if (signature) {
    const rpcUrl =
      getFlagValue("--rpc") ??
      process.env.SOLANA_RPC_URL ??
      "https://api.devnet.solana.com";
    const ixIndexRaw = getFlagValue("--ix-index") ?? "0";
    const ixIndex = Number.parseInt(ixIndexRaw, 10);
    if (Number.isNaN(ixIndex) || ixIndex < 0) {
      console.error(`Invalid --ix-index: ${ixIndexRaw}`);
      process.exit(1);
    }

    const connection = new Connection(rpcUrl, "confirmed");
    const programPk = new PublicKey(idl.address);
    let ixs: TransactionInstruction[];
    try {
      ixs = await fetchProgramInstructionsFromTx(
        connection,
        signature,
        programPk
      );
    } catch (e) {
      console.error(
        e instanceof Error ? e.message : "Failed to fetch transaction."
      );
      process.exit(1);
    }

    if (ixs.length === 0) {
      console.error(
        "No top-level instruction in this transaction targets idl.address. Check signature, cluster (RPC), and IDL program id."
      );
      process.exit(1);
    }

    if (ixIndex >= ixs.length) {
      console.error(
        `--ix-index ${ixIndex} is out of range; this transaction has ${ixs.length} instruction(s) for this program (use 0..${ixs.length - 1}).`
      );
      process.exit(1);
    }

    const ix = ixs[ixIndex];
    const strictProgramId = true;

    const input = {
      idlPath: idlResolved,
      idl: idlSummary,
      source: "transaction",
      transaction: {
        signature,
        rpcUrl,
        ixIndex,
        instructionsForProgram: ixs.length,
      },
      instruction: instructionToReport(ix, idl, strictProgramId, "from_chain"),
    };

    const parsed = parseAnchorInstruction(idl, ix, { strictProgramId });
    emitReport(input, parsed, outPath);
    return;
  }

  const { payload, payloadSource } = loadPayload();

  const encoding = payload.dataEncoding ?? "hex";
  const data = decodeData(payload.data, encoding);
  const programId = new PublicKey(payload.programId ?? idl.address);

  const ix = new TransactionInstruction({
    programId,
    keys: payload.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data,
  });

  const strictProgramId = payload.strictProgramId ?? true;

  const input = {
    idlPath: idlResolved,
    idl: idlSummary,
    source: "payload",
    payloadSource,
    payload,
    instruction: instructionToReport(ix, idl, strictProgramId, encoding),
  };

  const parsed = parseAnchorInstruction(idl, ix, { strictProgramId });
  emitReport(input, parsed, outPath);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
