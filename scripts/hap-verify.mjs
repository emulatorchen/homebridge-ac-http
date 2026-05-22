/**
 * HAP client — pairs with a Homebridge instance and lists every tile name
 * exactly as the iOS Home app would read them via the HAP protocol.
 */
import { createRequire } from 'module';
import { randomBytes } from 'crypto';

const require = createRequire(import.meta.url);
const { HttpClient } = require('hap-controller');

const [,, host = '127.0.0.1', portStr = '51826', pin = '111-11-111'] = process.argv;
const port = parseInt(portStr);

console.log(`\nConnecting to Homebridge at ${host}:${port}  PIN=${pin}\n`);

async function main() {
  const clientId = 'verify-' + randomBytes(4).toString('hex');
  const client = new HttpClient(clientId, host, port);

  // Step 1 — pair
  console.log('Pairing...');
  await client.pairSetup(pin);
  console.log('Paired OK.\n');

  // Step 2 — list accessories (same /accessories request iOS makes after pairing)
  const result = await client.getAccessories();

  // Raw HAP JSON — this is the actual protocol response iOS reads
  console.log('=== Raw HAP /accessories response from Homebridge ===');
  console.log(JSON.stringify(result, null, 2));

  console.log('\n=== Tile labels (AccessoryInformation.Name, HAP char 0x23) ===');
  for (const acc of result.accessories) {
    const infoSvc = acc.services.find(
      s => s.type === '0000003E-0000-1000-8000-0026BB765291'
    );
    if (!infoSvc) continue;
    const nameChar = infoSvc.characteristics.find(
      c => c.type === '00000023-0000-1000-8000-0026BB765291'
    );
    if (nameChar?.value) console.log('  TILE:', nameChar.value);
  }

  // Step 3 — write test: send On=false to every Switch companion
  // Proves onSet handlers are wired (unregistered handlers make tiles unresponsive in iOS).
  // Writing false is a safe no-op for all stateless/stateful Switch companions.
  const SWITCH_UUID = '00000049-0000-1000-8000-0026BB765291';
  const ON_UUID     = '00000025-0000-1000-8000-0026BB765291';
  console.log('\n=== Switch write test (proves companion onSet handlers are wired) ===');
  let writeCount = 0;
  for (const acc of result.accessories) {
    for (const svc of acc.services) {
      if (svc.type !== SWITCH_UUID) continue;
      const onChar = svc.characteristics.find(
        c => c.type === ON_UUID && Array.isArray(c.perms) && c.perms.includes('pw')
      );
      if (!onChar) continue;
      let status = 0;
      try {
        const res = await client.setCharacteristics({ [acc.aid]: { [onChar.iid]: false } });
        status = res?.characteristics?.[0]?.status ?? 0;
      } catch (e) {
        // hap-controller may throw on 204 No Content (empty body) — that means success
        const msg = String(e?.message ?? '');
        if (!msg.includes('trim') && !msg.includes('JSON') && !msg.includes('Unexpected')) throw e;
        status = 0;
      }
      // status 0 = success; SERVICE_COMMUNICATION_FAILURE (-70402) = no real AC, expected
      if (status !== 0 && status !== -70402) {
        console.error(`  WRITE FAILED: aid=${acc.aid} iid=${onChar.iid} status=${status}`);
        process.exit(1);
      }
      console.log(`  WRITE OK: aid=${acc.aid} iid=${onChar.iid} status=${status}`);
      writeCount++;
    }
  }
  if (writeCount === 0) {
    console.error('No writable Switch On characteristics found — companion services may be missing');
    process.exit(1);
  }
  console.log(`\nWrite test PASSED — ${writeCount} companion Switch handler(s) responded.`);

  console.log('\nVerification complete — these are the exact names iOS reads via HAP.');
  await client.close();
}

main().then(() => process.exit(0)).catch(e => { console.error('FAILED:', e.message); process.exit(1); });
