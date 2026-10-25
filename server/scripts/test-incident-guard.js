'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const read = name => fs.readFileSync(path.join(__dirname, '../../audit', name), 'utf8');
const unit = read('cr-incident-guard.service');
const source = read('cr-incident-guard.nft');
const ruleLines = source.split('\n').map(line => line.trim()).filter(line => line.startsWith('iifname '));
const rules = ruleLines.map(line => {
  const match = line.match(/^iifname (!= )?"([^"]+)" (?:iifname (!= )?"([^"]+)" )?(?:(ip6?) saddr ([a-f\d:.]+) )?(?:(tcp|udp) (dport|sport) (\{ [\d, ]+ \}|\d+) )?(?:ct state ([a-z,]+) )?counter (accept|drop)$/);
  assert(match, `Unmodelled rule must fail this contract test: ${line}`);
  const [, negate, network, negateSecond, secondNetwork, family, address, protocol, portType, ports, states, verdict] = match;
  return { negate: Boolean(negate), network, negateSecond: Boolean(negateSecond), secondNetwork,
    family, address, protocol, portType, ports: ports?.match(/\d+/g).map(Number), states: states?.split(','), verdict };
});

function verdict(packet) {
  for (const rule of rules) {
    if ((packet.network === rule.network) === rule.negate) continue;
    if (rule.secondNetwork && (packet.network === rule.secondNetwork) === rule.negateSecond) continue;
    if (rule.family && (packet.family !== rule.family || packet.address !== rule.address)) continue;
    if (rule.protocol && (packet.protocol !== rule.protocol || !rule.ports.includes(packet[rule.portType]))) continue;
    if (rule.states && !rule.states.includes(packet.state)) continue;
    return rule.verdict;
  }
  return 'accept';
}

test('unit stop does not delete containment and start/reload use the same atomic table replacement', () => {
  assert.match(unit, /^Type=oneshot$/m);
  assert.match(unit, /^RemainAfterExit=yes$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/nft -f \/etc\/nftables\/cr-incident-guard\.nft$/m);
  assert.match(unit, /^ExecReload=\/usr\/bin\/nft -f \/etc\/nftables\/cr-incident-guard\.nft$/m);
  assert.doesNotMatch(unit, /^ExecStop(?:Post)?=/m);
  assert.match(source, /^add table inet cr_incident_guard\ndelete table inet cr_incident_guard\ntable inet cr_incident_guard \{/);
  assert.doesNotMatch(source, /flush ruleset|delete table (?!inet cr_incident_guard)/);
  assert.match(source, /type filter hook input priority -10; policy accept;/);
  assert(rules.length > 20);
});

test('offline rule model blocks all recorded compromised peers before management exceptions in both address families', () => {
  const peers = rules.filter(rule => rule.address && rule.verdict === 'drop').map(rule => ({ family: rule.family, address: rule.address }));
  assert.equal(peers.length, 10);
  for (const peer of peers) for (const dport of [22, 111, 5901, 6080, 9090, 40020, 20003, 28888, 80]) {
    assert.equal(verdict({ ...peer, network: 'tailscale0', protocol: 'tcp', dport, sport: 50000, state: 'new' }), 'drop');
  }
});

test('database reply exception is limited by interface, peer, source port, protocol and conntrack state', () => {
  for (const peer of [{ family: 'ip', address: '100.64.0.2' }, { family: 'ip6', address: 'fd7a:115c:a1e0::5b36:2806' }]) {
    const packet = { ...peer, network: 'tailscale0', protocol: 'tcp', sport: 5432, dport: 50000, state: 'established' };
    assert.equal(verdict(packet), 'accept');
    for (const changed of [{ state: 'new' }, { sport: 50000 }, { protocol: 'udp' }]) assert.equal(verdict({ ...packet, ...changed }), 'drop');
    assert.equal(verdict({ ...packet, network: 'eth0', dport: 20003 }), 'drop');
  }
});

test('management allowlist is interface-bound while unknown tailnet and external clients are denied', () => {
  for (const peer of [{ family: 'ip', address: '100.109.60.58' }, { family: 'ip6', address: 'fd7a:115c:a1e0::4329:3c3b' }]) {
    for (const dport of [22, 111, 5901, 6080, 9090, 40020, 20003, 28888]) {
      const packet = { ...peer, network: 'tailscale0', protocol: 'tcp', dport, state: 'new' };
      assert.equal(verdict(packet), 'accept');
      assert.equal(verdict({ ...packet, address: peer.family === 'ip' ? '100.64.0.99' : 'fd7a:115c:a1e0::99' }), 'drop');
      assert.equal(verdict({ ...packet, network: 'eth0' }), 'drop');
      assert.equal(verdict({ ...packet, network: 'lo' }), 'accept');
    }
    const rpc = { ...peer, network: 'tailscale0', protocol: 'udp', dport: 111 };
    assert.equal(verdict(rpc), 'accept');
    assert.equal(verdict({ ...rpc, network: 'eth0' }), 'drop');
  }
});

test('this limited input guard does not claim full host isolation or block unrelated public HTTP', () => {
  assert.equal(verdict({ family: 'ip', address: '192.0.2.1', network: 'eth0', protocol: 'tcp', dport: 80 }), 'accept');
  assert.doesNotMatch(source, /hook (output|forward)/);
});
