import { expect, it, vi } from 'vitest';
import { env } from './helpers/env';
import { base64url, decodeBase64url, encryptPush, isPushConfigured, safePushEndpoint, sendWebPush, validPushKeys } from '../src/services/web-push';

// Public interoperability fixture from RFC 8291 section 5; never a deployment credential.
export const RFC_PUSH_PUBLIC = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
export const RFC_PUSH_PRIVATE = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
const receiver = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
it('matches the RFC 8291 published aes128gcm ciphertext exactly', async () => {
  const pub=decodeBase64url(RFC_PUSH_PUBLIC);
  const privateKey=await crypto.subtle.importKey('jwk',{kty:'EC',crv:'P-256',x:base64url(pub.slice(1,33)),y:base64url(pub.slice(33)),d:RFC_PUSH_PRIVATE},{name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
  const publicKey=await crypto.subtle.importKey('raw',pub,{name:'ECDH',namedCurve:'P-256'},true,[]);
  const body=await encryptPush(new TextEncoder().encode('When I grow up, I want to be a watermelon'),receiver,{keyPair:{privateKey,publicKey},salt:decodeBase64url('DGv6ra1nlYgDCS1FRnbzlw')});
  expect(base64url(body)).toBe('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});
it('fails closed without VAPID and rejects non-provider or malformed subscription keys',async()=>{
  expect(isPushConfigured(env)).toBe(false);
  for(const endpoint of ['https://evil.test/push','http://fcm.googleapis.com/a','https://fcm.googleapis.com.evil.test/a','https://u:p@fcm.googleapis.com/a','https://fcm.googleapis.com:8443/a','https://web.push.apple.com/a#x','https://127.0.0.1/a'])expect(safePushEndpoint(endpoint)).toBe(false);
  for(const endpoint of ['https://fcm.googleapis.com/fcm/send/a','https://updates.push.services.mozilla.com/wpush/v2/a','https://web.push.apple.com/a','https://wns2-bl2p.notify.windows.com/a'])expect(safePushEndpoint(endpoint)).toBe(true);
  expect(await validPushKeys(receiver.p256dh,receiver.auth)).toBe(true);
  expect(await validPushKeys(receiver.p256dh,'short')).toBe(false);
  expect(await validPushKeys(base64url(new Uint8Array(65).fill(4)),receiver.auth)).toBe(false);
  await expect(sendWebPush(env,{endpoint:'https://fcm.googleapis.com/a',...receiver},{title:'更新',body:'查看应用',data:{userId:'a',notificationId:'b',url:'/app/support/a'}})).rejects.toThrow('not configured');
});
it('signs an RFC 8292 VAPID JWT with raw ES256 and never follows redirects',async()=>{
  const configuration={...env,VAPID_PUBLIC_KEY:RFC_PUSH_PUBLIC,VAPID_PRIVATE_KEY:RFC_PUSH_PRIVATE,VAPID_SUBJECT:'https://example.test'};
  const mock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(null,{status:201}));
  try {
    expect(await sendWebPush(configuration,{endpoint:'https://fcm.googleapis.com/send/fixture',...receiver},{title:'更新',body:'查看应用',data:{userId:'user',notificationId:'12345678-1234-1234-1234-123456789012',url:'/app/support/abc'}})).toEqual({status:201});
    const init=mock.mock.calls[0]![1]!;const headers=new Headers(init.headers);expect(init.redirect).toBe('manual');expect(headers.get('Content-Encoding')).toBe('aes128gcm');
    const match=headers.get('Authorization')!.match(/^vapid t=([^,]+), k=(.+)$/)!;expect(match[2]).toBe(RFC_PUSH_PUBLIC);
    const [head,body,sig]=match[1]!.split('.');expect(decodeBase64url(sig!)).toHaveLength(64);
    const claims=JSON.parse(new TextDecoder().decode(decodeBase64url(body!)));expect(claims.aud).toBe('https://fcm.googleapis.com');expect(claims.exp).toBeLessThanOrEqual(Math.floor(Date.now()/1000)+86400);
    const key=await crypto.subtle.importKey('raw',decodeBase64url(RFC_PUSH_PUBLIC),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
    expect(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,decodeBase64url(sig!),new TextEncoder().encode(`${head}.${body}`))).toBe(true);
  } finally {mock.mockRestore();}
});
