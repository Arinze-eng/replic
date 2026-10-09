// deepseekPow.js — Correct DeepSeekHashV1 Proof-of-Work solver.
//
// chat.deepseek.com requires a valid PoW answer (header `x-ds-pow-response`)
// before every /chat/completion call. The algorithm is "DeepSeekHashV1" and is
// implemented in the shipped WebAssembly module (sha3_wasm_bg.*.wasm) that the
// real web client downloads. We load that exact module and call its `wasm_solve`
// export — this is the ONLY way to produce an answer DeepSeek accepts (a naive
// SHA-256 loop is rejected and the server silently returns an empty reply).
//
// wasm_solve(retptr, challengePtr, challengeLen, prefixPtr, prefixLen, difficulty)
//   - writes [ok:i32, nonce:f64] at retptr
//   - prefix = `${salt}_${expire_at}_`
// The returned nonce is the answer.

const fs = require('fs');
const path = require('path');

let _wasm = null; // { instance, memory, alloc, addToStack }

function _loadWasm() {
  if (_wasm) return _wasm;
  const wasmPath = path.join(__dirname, 'deepseek_wasm', 'sha3_wasm_bg.7b9ca65ddd.wasm');
  const bytes = fs.readFileSync(wasmPath);
  const mod = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(mod, {});
  const ex = instance.exports;
  _wasm = {
    exports: ex,
    memory: ex.memory,
    solve: ex.wasm_solve,
    addToStack: ex.__wbindgen_add_to_stack_pointer,
    alloc: ex.__wbindgen_export_0, // malloc(size, align) -> ptr
  };
  return _wasm;
}

function _writeString(w, str) {
  const bytes = Buffer.from(str, 'utf-8');
  const ptr = w.alloc(bytes.length, 1) >>> 0;
  new Uint8Array(w.memory.buffer).set(bytes, ptr);
  return { ptr, len: bytes.length };
}

/**
 * Solve a DeepSeek PoW challenge and return the base64 `x-ds-pow-response`
 * header value the API expects.
 * @param {object} challenge - { algorithm, challenge, salt, signature, difficulty, expire_at, target_path }
 * @returns {string} base64-encoded answer payload
 */
function solvePow(challenge) {
  const w = _loadWasm();
  const prefix = `${challenge.salt}_${challenge.expire_at}_`;
  const difficulty = Number(challenge.difficulty);

  // Reserve 16 bytes of stack for the [i32 status, f64 nonce] return struct.
  const retptr = w.addToStack(-16);
  try {
    const ch = _writeString(w, challenge.challenge);
    const pf = _writeString(w, prefix);

    w.solve(retptr, ch.ptr, ch.len, pf.ptr, pf.len, difficulty);

    const dv = new DataView(w.memory.buffer);
    const status = dv.getInt32(retptr, true);
    const nonce = dv.getFloat64(retptr + 8, true);

    if (status === 0) {
      throw new Error('wasm_solve returned status 0 (no solution found)');
    }

    const answer = Math.floor(nonce);
    const result = {
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
      target_path: challenge.target_path,
    };
    return Buffer.from(JSON.stringify(result)).toString('base64');
  } finally {
    w.addToStack(16);
  }
}

module.exports = { solvePow };
