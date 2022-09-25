import { bytesToBigInt, stringToBytes, toCircomBigIntBytes } from "../../src/helpers/binaryFormat";
import {
  AAYUSH_EMAIL_SIG,
  AAYUSH_EMAIL_MODULUS,
  AAYUSH_POSTHASH_MESSAGE_PADDED_INT,
  AAYUSH_PREHASH_MESSAGE_INT,
  AAYUSH_PREHASH_MESSAGE_STRING,
  CIRCOM_FIELD_MODULUS,
  MAX_SHA_INPUT_LENGTH_PADDED_BYTES,
} from "./constants";
import { shaHash } from "./shaHash";
import { dkimVerify } from "./dkim";
import { assert } from "console";
const pki = require("node-forge").pki;

interface ICircuitInputs {
  modulus?: string[];
  signature?: string[];
  base_message?: string[];
  in_padded?: string[];
  in_len_padded_bytes?: string;
}

enum CircuitType {
  RSA = "rsa",
  SHA = "sha",
  TEST = "test",
  EMAIL = "email",
}

// Works only on 32 bit sha text lengths
function int32toBytes(num: number): Uint8Array {
  let arr = new ArrayBuffer(4); // an Int32 takes 4 bytes
  let view = new DataView(arr);
  view.setUint32(0, num, false); // byteOffset = 0; litteEndian = false
  return new Uint8Array(arr);
}

// Works only on 32 bit sha text lengths
function int8toBytes(num: number): Uint8Array {
  let arr = new ArrayBuffer(1); // an Int8 takes 4 bytes
  let view = new DataView(arr);
  view.setUint8(0, num); // byteOffset = 0; litteEndian = false
  return new Uint8Array(arr);
}

function mergeUInt8Arrays(a1: Uint8Array, a2: Uint8Array): Uint8Array {
  // sum of individual array lengths
  var mergedArray = new Uint8Array(a1.length + a2.length);
  mergedArray.set(a1);
  mergedArray.set(a2, a1.length);
  return mergedArray;
}

async function sha256Pad(prehash_prepad_m: Uint8Array, maxShaBytes: number): Promise<[Uint8Array, number]> {
  let length_bits = prehash_prepad_m.length * 8; // bytes to bits
  let length_in_bytes = int32toBytes(length_bits);
  prehash_prepad_m = mergeUInt8Arrays(prehash_prepad_m, int8toBytes(2 ** 7));
  while ((prehash_prepad_m.length * 8 + length_in_bytes.length * 8) % 512 !== 0) {
    prehash_prepad_m = mergeUInt8Arrays(prehash_prepad_m, int8toBytes(0));
  }
  prehash_prepad_m = mergeUInt8Arrays(prehash_prepad_m, length_in_bytes);
  console.assert((prehash_prepad_m.length * 8) % 512 === 0, "Padding did not complete properly!");
  let messageLen = prehash_prepad_m.length;
  while (prehash_prepad_m.length < maxShaBytes) {
    prehash_prepad_m = mergeUInt8Arrays(prehash_prepad_m, int32toBytes(0));
  }
  console.assert(prehash_prepad_m.length === maxShaBytes, "Padding to max length did not complete properly!");

  return [prehash_prepad_m, messageLen];
}

function packBytesIntoNBytes(messagePadded: Uint8Array, n = 7): Array<number> {
  let output: Array<number> = [];
  for (let i = 0; i < messagePadded.length; i++) {
    if (i % n === 0) {
      output.push(0);
    }
    const j = (i / n) | 0;
    console.assert(j == output.length, "Packing loop invariants bug!");
    output[j] = messagePadded[i] >> i % n;
  }
  return output;
}

export async function getCircuitInputs(
  rsa_signature: bigint,
  rsa_modulus: bigint,
  message: Buffer,
  circuit: CircuitType
): Promise<{
  valid: {
    validSignatureFormat?: boolean;
    validMessage?: boolean;
  };
  circuitInputs?: ICircuitInputs;
}> {
  // Derive modulus from signature
  // const modulusBigInt = bytesToBigInt(pubKeyParts[2]);
  const modulusBigInt = rsa_modulus;
  const prehash_message_string = message;
  const baseMessageBigInt = AAYUSH_PREHASH_MESSAGE_INT; // bytesToBigInt(stringToBytes(message)) ||
  const postShaBigint = AAYUSH_POSTHASH_MESSAGE_PADDED_INT;
  const signatureBigInt = rsa_signature;
  const maxShaBytes = MAX_SHA_INPUT_LENGTH_PADDED_BYTES;

  // Perform conversions
  const prehashBytesUnpadded = Uint8Array.from(prehash_message_string);
  const postShaBigintUnpadded = bytesToBigInt(stringToBytes((await shaHash(prehashBytesUnpadded)).toString())) % CIRCOM_FIELD_MODULUS;
  const [messagePadded, messagePaddedLen] = await sha256Pad(prehashBytesUnpadded, maxShaBytes);

  // Compute identity revealer
  let circuitInputs;
  let modulus = toCircomBigIntBytes(modulusBigInt);
  let signature = toCircomBigIntBytes(signatureBigInt);
  let in_len_padded_bytes = messagePaddedLen.toString();
  let in_padded = Array.from(messagePadded).map((x) => x.toString());
  let in_padded_n_bytes = packBytesIntoNBytes(in_padded, 7);
  let base_message = toCircomBigIntBytes(postShaBigintUnpadded);

  if (circuit === CircuitType.RSA) {
    circuitInputs = {
      modulus,
      signature,
      base_message,
    };
  } else if (circuit === CircuitType.EMAIL) {
    circuitInputs = {
      modulus,
      signature,
      in_padded_n_bytes,
      in_len_padded_bytes,
    };
  } else if (circuit === CircuitType.SHA) {
    circuitInputs = {
      in_padded_n_bytes,
      in_len_padded_bytes,
    };
  }
  return {
    circuitInputs,
    valid: {},
  };
}

export async function generate_inputs(email: Buffer) {
  // console.log(email);
  const result = await dkimVerify(email);

  let sig = BigInt("0x" + Buffer.from(result.results[0].signature, "base64").toString("hex"));
  let message = result.results[0].status.signature_header;
  let circuitType = CircuitType.SHA;

  let pubkey = result.results[0].publicKey;
  const pubKeyData = pki.publicKeyFromPem(pubkey.toString());
  let modulus = BigInt(pubKeyData.n.toString());
  let fin_result = await getCircuitInputs(sig, modulus, message, circuitType);
  return fin_result.circuitInputs;
  // fs.writeFileSync(`./circuits/inputs/input_${circuitType}.json`, json_result, { flag: "w" });
}

/*import fs from "fs";
async function do_generate() {
  const email = fs.readFileSync('../email_verify/msg.eml');
  console.log(JSON.stringify(await generate_inputs(email)));
}*/

// do_generate();