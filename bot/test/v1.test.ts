import { describe, expect, it } from 'vitest';
import { clean } from '../src/v1';

describe('clean (anti-XSS para el innerHTML del APK)', () => {
  it('escapa HTML en cualquier profundidad y deja números intactos', () => {
    const out = clean({ a: '<img src=x onerror="AndroidWallet.sendTransfer()">', b: [{ c: "it's `x` & y" }], n: 1.5, z: null });
    expect(out.a).toBe('&lt;img src=x onerror=&quot;AndroidWallet.sendTransfer()&quot;&gt;');
    expect(out.b[0].c).toBe('it&#39;s &#96;x&#96; &amp; y');
    expect(out.n).toBe(1.5);
    expect(out.z).toBeNull();
  });
});
