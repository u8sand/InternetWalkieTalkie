import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1';
import { signSchnorr, publicKey, randomSecret, nostrEvent } from '../../public/js/core/schnorr.js';
import { fromHex, hex } from '../../public/js/core/encoding.js';

// Official BIP-340 test vectors 0-3.
const vectors = [
  ['0000000000000000000000000000000000000000000000000000000000000003', 'F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9', '0000000000000000000000000000000000000000000000000000000000000000', '0000000000000000000000000000000000000000000000000000000000000000', 'E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA821525F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0'],
  ['B7E151628AED2A6ABF7158809CF4F3C762E7160F38B4DA56A784D9045190CFEF', 'DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659', '0000000000000000000000000000000000000000000000000000000000000001', '243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89', '6896BD60EEAE296DB48A229FF71DFE071BDE413E6D43F917DC8DCF8C78DE33418906D11AC976ABCCB20B091292BFF4EA897EFCB639EA871CFA95F6DE339E4B0A'],
  ['C90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B14E5C9', 'DD308AFEC5777E13121FA72B9CC1B7CC0139715309B086C960E18FD969774EB8', 'C87AA53824B4B7C9C7E5A3F7A6C3D2B1A0F9E8D7C6B5A4938271605F4E3D2C1B', '7E2D58D8B3BCDF1ABADEC7829054F90DDA9805AAB56C77333024B9D0A508B75C', null],
];

test('BIP-340 vectors', async () => {
  for (const [sk, pk, aux, msg, sig] of vectors) {
    assert.equal(hex(publicKey(fromHex(sk))), pk.toLowerCase());
    const s = await signSchnorr(fromHex(msg), fromHex(sk), fromHex(aux));
    if (sig) assert.equal(hex(s), sig.toLowerCase());
    assert.ok(schnorr.verify(s, fromHex(msg), fromHex(pk)));
  }
});

test('random keys cross-verify with @noble/curves', async () => {
  for (let i = 0; i < 20; i++) {
    const sk = randomSecret();
    assert.equal(hex(publicKey(sk)), hex(schnorr.getPublicKey(sk)));
    const ev = await nostrEvent(sk, hex(publicKey(sk)), 25050, [['t', 'x']], 'hi');
    assert.ok(schnorr.verify(fromHex(ev.sig), fromHex(ev.id), fromHex(ev.pubkey)));
  }
});
