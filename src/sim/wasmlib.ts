/**
 * Runtime helper functions for the generated WASM simulation modules.
 *
 * They mirror the semantics of Verilator's runtime (include/verilated_funcs.h)
 * so that the generated code behaves exactly like the C++ that Verilator
 * would have emitted:
 *
 *  - narrow helpers (<= 64 bits): guarded division, sign extension, shifts
 *    with out-of-range amounts, arithmetic right shifts (VL_SHIFTRS_*)
 *  - wide helpers (> 64 bits): values are arrays of 32-bit words in linear
 *    memory, and all helpers take pointers (VL_ADD_W, VL_MUL_W, VL_SHIFTL_WWI...)
 *
 * Wide helpers never alias their destination with their sources; the code
 * generator always provides a fresh temporary as destination.
 */

let uid = 0;

const L = (x: string) => `(local.get $${x})`;
/** address of word i of pointer p */
const W = (p: string, i: string) => `(i32.add ${L(p)} (i32.shl ${i} (i32.const 2)))`;
const ld = (p: string, i: string) => `(i32.load ${W(p, i)})`;
const st = (p: string, i: string, v: string) => `(i32.store ${W(p, i)} ${v})`;
const set = (x: string, v: string) => `(local.set $${x} ${v})`;
const c32 = (n: number) => `(i32.const ${n | 0})`;

/** for (iv = start; iv < end; iv++) body   (signed comparison) */
function forUp(iv: string, start: string, end: string, body: string) {
  const id = ++uid;
  return `${set(iv, start)}
    (block $Bf${id} (loop $Cf${id}
      (br_if $Bf${id} (i32.ge_s ${L(iv)} ${end}))
      ${body}
      ${set(iv, `(i32.add ${L(iv)} ${c32(1)})`)}
      (br $Cf${id})))`;
}

/** for (iv = start; iv >= 0; iv--) body */
function forDown(iv: string, start: string, body: string) {
  const id = ++uid;
  return `${set(iv, start)}
    (block $Bd${id} (loop $Cd${id}
      (br_if $Bd${id} (i32.lt_s ${L(iv)} ${c32(0)}))
      ${body}
      ${set(iv, `(i32.sub ${L(iv)} ${c32(1)})`)}
      (br $Cd${id})))`;
}

/**
 * @param scratch address of a scratch area of 4 * maxWords words used by the
 *                wide division helpers
 * @param maxWords largest number of 32-bit words of any wide value
 */
export function wasmHelpers(scratch: number, maxWords: number): string {
  const S1 = scratch;
  const S2 = scratch + maxWords * 4;
  const S3 = scratch + maxWords * 8;
  const R = scratch + maxWords * 12;
  return `
  ;; ---------- narrow helpers ----------
  (func $divu32 (param $a i32) (param $b i32) (result i32)
    (if (result i32) (i32.eqz ${L('b')}) (then ${c32(0)}) (else (i32.div_u ${L('a')} ${L('b')}))))
  (func $remu32 (param $a i32) (param $b i32) (result i32)
    (if (result i32) (i32.eqz ${L('b')}) (then ${c32(0)}) (else (i32.rem_u ${L('a')} ${L('b')}))))
  (func $divu64 (param $a i64) (param $b i64) (result i64)
    (if (result i64) (i64.eqz ${L('b')}) (then (i64.const 0)) (else (i64.div_u ${L('a')} ${L('b')}))))
  (func $remu64 (param $a i64) (param $b i64) (result i64)
    (if (result i64) (i64.eqz ${L('b')}) (then (i64.const 0)) (else (i64.rem_u ${L('a')} ${L('b')}))))
  (func $divs32 (param $a i32) (param $b i32) (result i32)
    (if (i32.eqz ${L('b')}) (then (return ${c32(0)})))
    (if (i32.and (i32.eq ${L('a')} (i32.const -2147483648)) (i32.eq ${L('b')} (i32.const -1)))
      (then (return ${c32(0)})))
    (i32.div_s ${L('a')} ${L('b')}))
  (func $rems32 (param $a i32) (param $b i32) (result i32)
    (if (i32.eqz ${L('b')}) (then (return ${c32(0)})))
    (if (i32.and (i32.eq ${L('a')} (i32.const -2147483648)) (i32.eq ${L('b')} (i32.const -1)))
      (then (return ${c32(0)})))
    (i32.rem_s ${L('a')} ${L('b')}))
  (func $divs64 (param $a i64) (param $b i64) (result i64)
    (if (i64.eqz ${L('b')}) (then (return (i64.const 0))))
    (if (i32.and (i64.eq ${L('a')} (i64.const -9223372036854775808)) (i64.eq ${L('b')} (i64.const -1)))
      (then (return (i64.const 0))))
    (i64.div_s ${L('a')} ${L('b')}))
  (func $rems64 (param $a i64) (param $b i64) (result i64)
    (if (i64.eqz ${L('b')}) (then (return (i64.const 0))))
    (if (i32.and (i64.eq ${L('a')} (i64.const -9223372036854775808)) (i64.eq ${L('b')} (i64.const -1)))
      (then (return (i64.const 0))))
    (i64.rem_s ${L('a')} ${L('b')}))

  ;; VL_EXTENDS: set all bits above lbits when bit lbits-1 is set (1 <= lbits <= 32/64)
  (func $sext32 (param $x i32) (param $l i32) (result i32)
    (i32.or ${L('x')} (i32.sub ${c32(0)} (i32.and ${L('x')} (i32.shl ${c32(1)} (i32.sub ${L('l')} ${c32(1)}))))))
  (func $sext64 (param $x i64) (param $l i32) (result i64)
    (i64.or ${L('x')} (i64.sub (i64.const 0) (i64.and ${L('x')}
      (i64.shl (i64.const 1) (i64.extend_i32_u (i32.sub ${L('l')} ${c32(1)})))))))

  ;; VL_MASK_I/Q: low n bits set (n >= width -> all ones)
  (func $mask32 (param $n i32) (result i32)
    (if (result i32) (i32.ge_u ${L('n')} ${c32(32)}) (then ${c32(-1)})
      (else (i32.sub (i32.shl ${c32(1)} ${L('n')}) ${c32(1)}))))
  (func $mask64 (param $n i32) (result i64)
    (if (result i64) (i32.ge_u ${L('n')} ${c32(64)}) (then (i64.const -1))
      (else (i64.sub (i64.shl (i64.const 1) (i64.extend_i32_u ${L('n')})) (i64.const 1)))))
  ;; VL_MASK_E: mask of the valid bits in the top word of an n-bit wide value
  (func $maskE (param $n i32) (result i32)
    (if (result i32) (i32.and ${L('n')} ${c32(31)})
      (then (i32.sub (i32.shl ${c32(1)} (i32.and ${L('n')} ${c32(31)})) ${c32(1)}))
      (else ${c32(-1)})))

  ;; shift amounts: saturate wider amounts to 0xffffffff ("huge")
  (func $sat64 (param $x i64) (result i32)
    (if (result i32) (i64.lt_u ${L('x')} (i64.const 4294967296))
      (then (i32.wrap_i64 ${L('x')})) (else ${c32(-1)})))
  (func $w_shamt (param $p i32) (param $n i32) (result i32) (local $i i32)
    ${forUp('i', c32(1), L('n'), `(if ${ld('p', L('i'))} (then (return ${c32(-1)})))`)}
    ${ld('p', c32(0))})

  ;; VL_SHIFTL/VL_SHIFTR with shift amounts >= container width
  (func $shl32 (param $x i32) (param $n i32) (result i32)
    (if (result i32) (i32.ge_u ${L('n')} ${c32(32)}) (then ${c32(0)}) (else (i32.shl ${L('x')} ${L('n')}))))
  (func $shr32 (param $x i32) (param $n i32) (result i32)
    (if (result i32) (i32.ge_u ${L('n')} ${c32(32)}) (then ${c32(0)}) (else (i32.shr_u ${L('x')} ${L('n')}))))
  (func $shl64 (param $x i64) (param $n i32) (result i64)
    (if (result i64) (i32.ge_u ${L('n')} ${c32(64)}) (then (i64.const 0))
      (else (i64.shl ${L('x')} (i64.extend_i32_u ${L('n')})))))
  (func $shr64 (param $x i64) (param $n i32) (result i64)
    (if (result i64) (i32.ge_u ${L('n')} ${c32(64)}) (then (i64.const 0))
      (else (i64.shr_u ${L('x')} (i64.extend_i32_u ${L('n')})))))

  ;; VL_SHIFTRS_III(obits, lbits, rbits, lhs, rhs)
  (func $shrs32 (param $x i32) (param $n i32) (param $obits i32) (param $lbits i32) (result i32)
    (local $sign i32)
    ${set('sign', `(i32.sub ${c32(0)} (i32.shr_u ${L('x')} (i32.sub ${L('lbits')} ${c32(1)})))`)}
    (if (i32.ge_u ${L('n')} ${c32(32)})
      (then (return (i32.and ${L('sign')} (call $mask32 ${L('obits')})))))
    (i32.or (i32.shr_u ${L('x')} ${L('n')})
      (i32.and ${L('sign')} (i32.and (call $mask32 ${L('obits')})
        (i32.xor (i32.shr_u (call $mask32 ${L('lbits')}) ${L('n')}) ${c32(-1)})))))
  ;; VL_SHIFTRS_QQI(obits, lbits, rbits, lhs, rhs)
  (func $shrs64 (param $x i64) (param $n i32) (param $obits i32) (param $lbits i32) (result i64)
    (local $sign i64)
    ${set('sign', `(i64.sub (i64.const 0) (i64.shr_u ${L('x')} (i64.extend_i32_u (i32.sub ${L('lbits')} ${c32(1)}))))`)}
    (if (i32.ge_u ${L('n')} ${c32(64)})
      (then (return (i64.and ${L('sign')} (call $mask64 ${L('obits')})))))
    (i64.or (i64.shr_u ${L('x')} (i64.extend_i32_u ${L('n')}))
      (i64.and ${L('sign')} (i64.and (call $mask64 ${L('obits')})
        (i64.xor (i64.shr_u (call $mask64 ${L('lbits')}) (i64.extend_i32_u ${L('n')})) (i64.const -1))))))

  ;; integer power (VL_POW_*), modulo 2^32/2^64
  (func $powu32 (param $b i32) (param $e i32) (result i32) (local $r i32)
    ${set('r', c32(1))}
    (block $done (loop $lp
      (br_if $done (i32.eqz ${L('e')}))
      (if (i32.and ${L('e')} ${c32(1)}) (then ${set('r', `(i32.mul ${L('r')} ${L('b')})`)}))
      ${set('b', `(i32.mul ${L('b')} ${L('b')})`)}
      ${set('e', `(i32.shr_u ${L('e')} ${c32(1)})`)}
      (br $lp)))
    ${L('r')})
  (func $powu64 (param $b i64) (param $e i64) (result i64) (local $r i64)
    ${set('r', '(i64.const 1)')}
    (block $done (loop $lp
      (br_if $done (i64.eqz ${L('e')}))
      (if (i32.wrap_i64 (i64.and ${L('e')} (i64.const 1))) (then ${set('r', `(i64.mul ${L('r')} ${L('b')})`)}))
      ${set('b', `(i64.mul ${L('b')} ${L('b')})`)}
      ${set('e', `(i64.shr_u ${L('e')} (i64.const 1))`)}
      (br $lp)))
    ${L('r')})

  ;; ---------- wide helpers (pointers to 32-bit words) ----------
  (func $w_copy (param $d i32) (param $s i32) (param $n i32)
    (memory.copy ${L('d')} ${L('s')} (i32.shl ${L('n')} ${c32(2)})))
  (func $w_zero (param $d i32) (param $n i32)
    (memory.fill ${L('d')} ${c32(0)} (i32.shl ${L('n')} ${c32(2)})))
  ;; set word 0..1 from a 64-bit value, zero the rest
  (func $w_from64 (param $d i32) (param $n i32) (param $x i64)
    (call $w_zero ${L('d')} ${L('n')})
    ${st('d', c32(0), `(i32.wrap_i64 ${L('x')})`)}
    (if (i32.gt_s ${L('n')} ${c32(1)})
      (then ${st('d', c32(1), `(i32.wrap_i64 (i64.shr_u ${L('x')} (i64.const 32)))`)})))
  ;; VL_EXTENDS_WI/WQ: value x has lbits valid bits
  (func $w_sext64 (param $d i32) (param $n i32) (param $x i64) (param $lbits i32)
    (local $sw i32) (local $sign i32) (local $i i32)
    (call $w_from64 ${L('d')} ${L('n')} ${L('x')})
    ${set('sw', `(i32.shr_u (i32.sub ${L('lbits')} ${c32(1)}) ${c32(5)})`)}
    ${set('sign', `(i32.and (i32.shr_u ${ld('d', L('sw'))} (i32.and (i32.sub ${L('lbits')} ${c32(1)}) ${c32(31)})) ${c32(1)})`)}
    (if ${L('sign')} (then
      ${st('d', L('sw'), `(i32.or ${ld('d', L('sw'))} (i32.xor (call $maskE ${L('lbits')}) ${c32(-1)}))`)}
      ${forUp('i', `(i32.add ${L('sw')} ${c32(1)})`, L('n'), st('d', L('i'), c32(-1)))})))
  ;; VL_EXTEND_WW / VL_EXTENDS_WW from a wide value of lbits
  (func $w_extend (param $d i32) (param $n i32) (param $s i32) (param $lbits i32) (param $signed i32)
    (local $lw i32) (local $i i32) (local $fill i32)
    ${set('lw', `(i32.shr_u (i32.add ${L('lbits')} ${c32(31)}) ${c32(5)})`)}
    ${forUp('i', c32(0), L('lw'), st('d', L('i'), ld('s', L('i'))))}
    (if (i32.and ${L('signed')} (i32.and (i32.shr_u ${ld('s', `(i32.sub ${L('lw')} ${c32(1)})`)}
          (i32.and (i32.sub ${L('lbits')} ${c32(1)}) ${c32(31)})) ${c32(1)}))
      (then
        ${set('fill', c32(-1))}
        ${st('d', `(i32.sub ${L('lw')} ${c32(1)})`, `(i32.or ${ld('d', `(i32.sub ${L('lw')} ${c32(1)})`)} (i32.xor (call $maskE ${L('lbits')}) ${c32(-1)}))`)}))
    ${forUp('i', L('lw'), L('n'), st('d', L('i'), L('fill')))})

  (func $w_not (param $d i32) (param $a i32) (param $n i32) (local $i i32)
    ${forUp('i', c32(0), L('n'), st('d', L('i'), `(i32.xor ${ld('a', L('i'))} ${c32(-1)})`))})
  (func $w_and (param $d i32) (param $a i32) (param $b i32) (param $n i32) (local $i i32)
    ${forUp('i', c32(0), L('n'), st('d', L('i'), `(i32.and ${ld('a', L('i'))} ${ld('b', L('i'))})`))})
  (func $w_or (param $d i32) (param $a i32) (param $b i32) (param $n i32) (local $i i32)
    ${forUp('i', c32(0), L('n'), st('d', L('i'), `(i32.or ${ld('a', L('i'))} ${ld('b', L('i'))})`))})
  (func $w_xor (param $d i32) (param $a i32) (param $b i32) (param $n i32) (local $i i32)
    ${forUp('i', c32(0), L('n'), st('d', L('i'), `(i32.xor ${ld('a', L('i'))} ${ld('b', L('i'))})`))})

  ;; VL_ADD_W
  (func $w_add (param $d i32) (param $a i32) (param $b i32) (param $n i32) (local $i i32) (local $c i64)
    ${forUp(
      'i',
      c32(0),
      L('n'),
      `
      ${set('c', `(i64.add ${L('c')} (i64.add (i64.extend_i32_u ${ld('a', L('i'))}) (i64.extend_i32_u ${ld('b', L('i'))})))`)}
      ${st('d', L('i'), `(i32.wrap_i64 ${L('c')})`)}
      ${set('c', `(i64.shr_u ${L('c')} (i64.const 32))`)}`,
    )})
  ;; VL_SUB_W
  (func $w_sub (param $d i32) (param $a i32) (param $b i32) (param $n i32) (local $i i32) (local $c i64)
    ${set('c', '(i64.const 1)')}
    ${forUp(
      'i',
      c32(0),
      L('n'),
      `
      ${set('c', `(i64.add ${L('c')} (i64.add (i64.extend_i32_u ${ld('a', L('i'))}) (i64.extend_i32_u (i32.xor ${ld('b', L('i'))} ${c32(-1)}))))`)}
      ${st('d', L('i'), `(i32.wrap_i64 ${L('c')})`)}
      ${set('c', `(i64.shr_u ${L('c')} (i64.const 32))`)}`,
    )})
  ;; VL_NEGATE_W
  (func $w_neg (param $d i32) (param $a i32) (param $n i32) (local $i i32) (local $c i64)
    ${set('c', '(i64.const 1)')}
    ${forUp(
      'i',
      c32(0),
      L('n'),
      `
      ${set('c', `(i64.add ${L('c')} (i64.extend_i32_u (i32.xor ${ld('a', L('i'))} ${c32(-1)})))`)}
      ${st('d', L('i'), `(i32.wrap_i64 ${L('c')})`)}
      ${set('c', `(i64.shr_u ${L('c')} (i64.const 32))`)}`,
    )})
  ;; VL_MUL_W
  (func $w_mul (param $d i32) (param $a i32) (param $b i32) (param $n i32)
    (local $l i32) (local $r i32) (local $q i32) (local $m i64)
    (call $w_zero ${L('d')} ${L('n')})
    ${forUp(
      'l',
      c32(0),
      L('n'),
      forUp(
        'r',
        c32(0),
        `(i32.sub ${L('n')} ${L('l')})`,
        `
      ${set('m', `(i64.mul (i64.extend_i32_u ${ld('a', L('l'))}) (i64.extend_i32_u ${ld('b', L('r'))}))`)}
      ${forUp(
        'q',
        `(i32.add ${L('l')} ${L('r')})`,
        L('n'),
        `
        ${set('m', `(i64.add ${L('m')} (i64.extend_i32_u ${ld('d', L('q'))}))`)}
        ${st('d', L('q'), `(i32.wrap_i64 ${L('m')})`)}
        ${set('m', `(i64.shr_u ${L('m')} (i64.const 32))`)}`,
      )}`,
      ),
    )})

  ;; comparisons
  (func $w_eq (param $a i32) (param $b i32) (param $n i32) (result i32) (local $i i32) (local $x i32)
    ${forUp('i', c32(0), L('n'), set('x', `(i32.or ${L('x')} (i32.xor ${ld('a', L('i'))} ${ld('b', L('i'))}))`))}
    (i32.eqz ${L('x')}))
  ;; _vl_cmp_w: -1, 0, 1
  (func $w_cmp (param $a i32) (param $b i32) (param $n i32) (result i32) (local $i i32)
    ${forDown(
      'i',
      `(i32.sub ${L('n')} ${c32(1)})`,
      `
      (if (i32.gt_u ${ld('a', L('i'))} ${ld('b', L('i'))}) (then (return ${c32(1)})))
      (if (i32.lt_u ${ld('a', L('i'))} ${ld('b', L('i'))}) (then (return ${c32(-1)})))`,
    )}
    ${c32(0)})
  ;; _vl_cmps_w
  (func $w_cmps (param $a i32) (param $b i32) (param $lbits i32) (result i32)
    (local $n i32) (local $ls i32) (local $rs i32) (local $bit i32)
    ${set('n', `(i32.shr_u (i32.add ${L('lbits')} ${c32(31)}) ${c32(5)})`)}
    ${set('bit', `(i32.and (i32.sub ${L('lbits')} ${c32(1)}) ${c32(31)})`)}
    ${set('ls', `(i32.and (i32.shr_u ${ld('a', `(i32.sub ${L('n')} ${c32(1)})`)} ${L('bit')}) ${c32(1)})`)}
    ${set('rs', `(i32.and (i32.shr_u ${ld('b', `(i32.sub ${L('n')} ${c32(1)})`)} ${L('bit')}) ${c32(1)})`)}
    (if (i32.and (i32.eqz ${L('ls')}) ${L('rs')}) (then (return ${c32(1)})))
    (if (i32.and ${L('ls')} (i32.eqz ${L('rs')})) (then (return ${c32(-1)})))
    (call $w_cmp ${L('a')} ${L('b')} ${L('n')}))

  ;; reductions
  (func $w_redor (param $a i32) (param $n i32) (result i32) (local $i i32) (local $x i32)
    ${forUp('i', c32(0), L('n'), set('x', `(i32.or ${L('x')} ${ld('a', L('i'))})`))}
    (i32.ne ${L('x')} ${c32(0)}))
  (func $w_redxor (param $a i32) (param $n i32) (result i32) (local $i i32) (local $x i32)
    ${forUp('i', c32(0), L('n'), set('x', `(i32.xor ${L('x')} ${ld('a', L('i'))})`))}
    (i32.and (i32.popcnt ${L('x')}) ${c32(1)}))
  (func $w_redand (param $a i32) (param $width i32) (result i32) (local $i i32) (local $n i32) (local $m i32)
    ${set('n', `(i32.shr_u (i32.add ${L('width')} ${c32(31)}) ${c32(5)})`)}
    ${forUp('i', c32(0), `(i32.sub ${L('n')} ${c32(1)})`, `(if (i32.ne ${ld('a', L('i'))} ${c32(-1)}) (then (return ${c32(0)})))`)}
    ${set('m', `(call $maskE ${L('width')})`)}
    (i32.eq (i32.and ${ld('a', `(i32.sub ${L('n')} ${c32(1)})`)} ${L('m')}) ${L('m')}))
  (func $w_popcnt (param $a i32) (param $n i32) (result i32) (local $i i32) (local $x i32)
    ${forUp('i', c32(0), L('n'), set('x', `(i32.add ${L('x')} (i32.popcnt ${ld('a', L('i'))}))`))}
    ${L('x')})

  ;; 32 bits of a wide value starting at (signed) bit position pos; zero outside [0, n*32)
  (func $w_getword (param $a i32) (param $n i32) (param $pos i32) (result i32)
    (local $w i32) (local $b i32) (local $lo i32) (local $hi i32)
    ${set('w', `(i32.shr_s ${L('pos')} ${c32(5)})`)}
    ${set('b', `(i32.and ${L('pos')} ${c32(31)})`)}
    (if (i32.and (i32.ge_s ${L('w')} ${c32(0)}) (i32.lt_s ${L('w')} ${L('n')}))
      (then ${set('lo', ld('a', L('w')))}))
    (if (i32.eqz ${L('b')}) (then (return ${L('lo')})))
    (if (i32.and (i32.ge_s (i32.add ${L('w')} ${c32(1)}) ${c32(0)}) (i32.lt_s (i32.add ${L('w')} ${c32(1)}) ${L('n')}))
      (then ${set('hi', ld('a', `(i32.add ${L('w')} ${c32(1)})`))}))
    (i32.or (i32.shr_u ${L('lo')} ${L('b')}) (i32.shl ${L('hi')} (i32.sub ${c32(32)} ${L('b')}))))
  ;; 64 bits starting at bit pos
  (func $w_getbits (param $a i32) (param $n i32) (param $pos i32) (result i64)
    (i64.or (i64.extend_i32_u (call $w_getword ${L('a')} ${L('n')} ${L('pos')}))
      (i64.shl (i64.extend_i32_u (call $w_getword ${L('a')} ${L('n')} (i32.add ${L('pos')} ${c32(32)}))) (i64.const 32))))
  ;; d[0..dn) = a >> pos
  (func $w_extract (param $d i32) (param $dn i32) (param $a i32) (param $an i32) (param $pos i32) (local $i i32)
    ${forUp('i', c32(0), L('dn'), st('d', L('i'), `(call $w_getword ${L('a')} ${L('an')} (i32.add ${L('pos')} (i32.shl ${L('i')} ${c32(5)})))`))})
  ;; insert width bits from s at bit lsb of d
  (func $w_insert (param $d i32) (param $lsb i32) (param $width i32) (param $s i32) (local $k i32) (local $p i32)
    ${forUp(
      'k',
      c32(0),
      L('width'),
      `
      ${set('p', `(i32.add ${L('lsb')} ${L('k')})`)}
      ${st(
        'd',
        `(i32.shr_u ${L('p')} ${c32(5)})`,
        `(i32.or
        (i32.and ${ld('d', `(i32.shr_u ${L('p')} ${c32(5)})`)} (i32.xor (i32.shl ${c32(1)} ${L('p')}) ${c32(-1)}))
        (i32.shl (i32.and (i32.shr_u ${ld('s', `(i32.shr_u ${L('k')} ${c32(5)})`)} ${L('k')}) ${c32(1)}) ${L('p')}))`,
      )}`,
    )})

  ;; VL_SHIFTL_WWI(obits, ...)
  (func $w_shl (param $d i32) (param $a i32) (param $amt i32) (param $obits i32) (local $n i32) (local $i i32)
    ${set('n', `(i32.shr_u (i32.add ${L('obits')} ${c32(31)}) ${c32(5)})`)}
    (if (i32.ge_u ${L('amt')} ${L('obits')}) (then (call $w_zero ${L('d')} ${L('n')}) (return)))
    ${forUp('i', c32(0), L('n'), st('d', L('i'), `(call $w_getword ${L('a')} ${L('n')} (i32.sub (i32.shl ${L('i')} ${c32(5)}) ${L('amt')}))`))}
    (if (i32.and ${L('amt')} ${c32(31)}) (then
      ${st('d', `(i32.sub ${L('n')} ${c32(1)})`, `(i32.and ${ld('d', `(i32.sub ${L('n')} ${c32(1)})`)} (call $maskE ${L('obits')}))`)})))
  ;; VL_SHIFTR_WWI(obits, ...)
  (func $w_shr (param $d i32) (param $a i32) (param $amt i32) (param $obits i32) (local $n i32) (local $nw i32) (local $i i32)
    ${set('n', `(i32.shr_u (i32.add ${L('obits')} ${c32(31)}) ${c32(5)})`)}
    (call $w_zero ${L('d')} ${L('n')})
    (if (i32.ge_u ${L('amt')} ${L('obits')}) (then (return)))
    ${set('nw', `(i32.shr_u (i32.add (i32.sub ${L('obits')} ${L('amt')}) ${c32(31)}) ${c32(5)})`)}
    (if (i32.eqz (i32.and ${L('amt')} ${c32(31)})) (then
      ${set('nw', `(i32.sub ${L('n')} (i32.shr_u ${L('amt')} ${c32(5)}))`)}))
    ${forUp('i', c32(0), L('nw'), st('d', L('i'), `(call $w_getword ${L('a')} ${L('n')} (i32.add (i32.shl ${L('i')} ${c32(5)}) ${L('amt')}))`))})
  ;; VL_SHIFTRS_WWI(obits, lbits, ...)
  (func $w_shrs (param $d i32) (param $a i32) (param $amt i32) (param $obits i32) (param $lbits i32)
    (local $n i32) (local $lmsw i32) (local $sign i32) (local $ws i32) (local $lo i32) (local $nw i32) (local $i i32)
    ${set('n', `(i32.shr_u (i32.add ${L('obits')} ${c32(31)}) ${c32(5)})`)}
    ${set('lmsw', `(i32.sub ${L('n')} ${c32(1)})`)}
    ${set('sign', `(i32.sub ${c32(0)} (i32.and (i32.shr_u ${ld('a', L('lmsw'))} (i32.and (i32.sub ${L('lbits')} ${c32(1)}) ${c32(31)})) ${c32(1)}))`)}
    ${set('ws', `(i32.shr_u ${L('amt')} ${c32(5)})`)}
    ${set('lo', `(i32.and ${L('amt')} ${c32(31)})`)}
    (if (i32.ge_u ${L('amt')} ${L('obits')})
      (then ${forUp('i', c32(0), L('n'), st('d', L('i'), L('sign')))})
      (else (if (i32.eqz ${L('lo')})
        (then
          ${set('nw', `(i32.sub ${L('n')} ${L('ws')})`)}
          ${forUp('i', c32(0), L('nw'), st('d', L('i'), ld('a', `(i32.add ${L('i')} ${L('ws')})`)))}
          ${st('d', `(i32.sub ${L('nw')} ${c32(1)})`, `(i32.or ${ld('d', `(i32.sub ${L('nw')} ${c32(1)})`)} (i32.and (i32.xor (call $maskE ${L('obits')}) ${c32(-1)}) ${L('sign')}))`)}
          ${forUp('i', L('nw'), L('n'), st('d', L('i'), L('sign')))})
        (else
          ${set('nw', `(i32.shr_u (i32.add (i32.sub ${L('obits')} ${L('amt')}) ${c32(31)}) ${c32(5)})`)}
          ${forUp(
            'i',
            c32(0),
            L('nw'),
            `
            ${st('d', L('i'), `(i32.shr_u ${ld('a', `(i32.add ${L('i')} ${L('ws')})`)} ${L('lo')})`)}
            (if (i32.lt_s (i32.add (i32.add ${L('i')} ${L('ws')}) ${c32(1)}) ${L('n')}) (then
              ${st('d', L('i'), `(i32.or ${ld('d', L('i'))} (i32.shl ${ld('a', `(i32.add (i32.add ${L('i')} ${L('ws')}) ${c32(1)})`)} (i32.sub ${c32(32)} ${L('lo')})))`)}))`,
          )}
          (if ${L('nw')} (then
            ${st('d', `(i32.sub ${L('nw')} ${c32(1)})`, `(i32.or ${ld('d', `(i32.sub ${L('nw')} ${c32(1)})`)} (i32.and ${L('sign')} (i32.xor (call $maskE (i32.sub ${L('obits')} ${L('lo')})) ${c32(-1)})))`)}))
          ${forUp('i', L('nw'), L('n'), st('d', L('i'), L('sign')))}))))
    ${st('d', L('lmsw'), `(i32.and ${ld('d', L('lmsw'))} (call $maskE ${L('lbits')}))`)})

  ;; unsigned division/modulo by shift-subtract (VL_DIV_WWW / VL_MODDIV_WWW, x/0 == 0)
  (func $w_divmod (param $d i32) (param $a i32) (param $b i32) (param $n i32) (param $ismod i32)
    (local $i i32) (local $k i32) (local $r i32)
    ${set('r', c32(R))}
    (call $w_zero ${L('d')} ${L('n')})
    (if (i32.eqz (call $w_redor ${L('b')} ${L('n')})) (then (return)))
    (call $w_zero ${L('r')} ${L('n')})
    ${forDown(
      'i',
      `(i32.sub (i32.shl ${L('n')} ${c32(5)}) ${c32(1)})`,
      `
      ;; r = (r << 1) | bit i of a
      ${forDown(
        'k',
        `(i32.sub ${L('n')} ${c32(1)})`,
        st(
          'r',
          L('k'),
          `(i32.or (i32.shl ${ld('r', L('k'))} ${c32(1)})
          (if (result i32) ${L('k')} (then (i32.shr_u ${ld('r', `(i32.sub ${L('k')} ${c32(1)})`)} ${c32(31)})) (else ${c32(0)})))`,
        ),
      )}
      ${st('r', c32(0), `(i32.or ${ld('r', c32(0))} (i32.and (i32.shr_u ${ld('a', `(i32.shr_u ${L('i')} ${c32(5)})`)} ${L('i')}) ${c32(1)}))`)}
      (if (i32.ge_s (call $w_cmp ${L('r')} ${L('b')} ${L('n')}) ${c32(0)}) (then
        (call $w_sub ${L('r')} ${L('r')} ${L('b')} ${L('n')})
        ${st('d', `(i32.shr_u ${L('i')} ${c32(5)})`, `(i32.or ${ld('d', `(i32.shr_u ${L('i')} ${c32(5)})`)} (i32.shl ${c32(1)} ${L('i')}))`)}))`,
    )}
    (if ${L('ismod')} (then (call $w_copy ${L('d')} ${L('r')} ${L('n')}))))
  ;; VL_DIVS_WWW / VL_MODDIVS_WWW
  (func $w_divs (param $d i32) (param $a i32) (param $b i32) (param $lbits i32) (param $ismod i32)
    (local $n i32) (local $ls i32) (local $rs i32) (local $bit i32) (local $pa i32) (local $pb i32)
    ${set('n', `(i32.shr_u (i32.add ${L('lbits')} ${c32(31)}) ${c32(5)})`)}
    ${set('bit', `(i32.and (i32.sub ${L('lbits')} ${c32(1)}) ${c32(31)})`)}
    ${set('ls', `(i32.and (i32.shr_u ${ld('a', `(i32.sub ${L('n')} ${c32(1)})`)} ${L('bit')}) ${c32(1)})`)}
    ${set('rs', `(i32.and (i32.shr_u ${ld('b', `(i32.sub ${L('n')} ${c32(1)})`)} ${L('bit')}) ${c32(1)})`)}
    ${set('pa', L('a'))}
    ${set('pb', L('b'))}
    (if ${L('ls')} (then
      (call $w_neg ${c32(S1)} ${L('a')} ${L('n')})
      (call $w_clean ${c32(S1)} ${L('lbits')})
      ${set('pa', c32(S1))}))
    (if ${L('rs')} (then
      (call $w_neg ${c32(S2)} ${L('b')} ${L('n')})
      (call $w_clean ${c32(S2)} ${L('lbits')})
      ${set('pb', c32(S2))}))
    (call $w_divmod ${c32(S3)} ${L('pa')} ${L('pb')} ${L('n')} ${L('ismod')})
    (if (if (result i32) ${L('ismod')} (then ${L('ls')}) (else (i32.xor ${L('ls')} ${L('rs')})))
      (then
        (call $w_neg ${L('d')} ${c32(S3)} ${L('n')})
        (call $w_clean ${L('d')} ${L('lbits')}))
      (else (call $w_copy ${L('d')} ${c32(S3)} ${L('n')}))))
  ;; mask the top word to the valid bits
  (func $w_clean (param $d i32) (param $bits i32) (local $t i32)
    ${set('t', `(i32.shr_u (i32.sub ${L('bits')} ${c32(1)}) ${c32(5)})`)}
    ${st('d', L('t'), `(i32.and ${ld('d', L('t'))} (call $maskE ${L('bits')}))`)})
`;
}

/** Size in bytes of the scratch area needed by wasmHelpers() */
export function helperScratchSize(maxWords: number) {
  return maxWords * 16;
}
