// Which resolved addresses the relay may connect to. Only globally routable unicast: every private,
// loopback, link-local, shared (CGNAT), documentation, benchmarking, multicast and reserved range is
// refused, as are IPv4-mapped/translated/6to4/Teredo IPv6 forms that could smuggle one of them in.
// The check runs inside the connect-time DNS lookup (see upstream.ts), so the address checked is the
// address used: a DNS answer that changes between requests is checked again on every request.
import { BlockList, isIP } from 'node:net'

const V4_DENY: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // shared address space (CGNAT)
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, including cloud metadata 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved and limited broadcast
]

// IPv6 is allowed only inside global unicast 2000::/3, minus these.
const V6_DENY: Array<[string, number]> = [
  ['2001::', 23], // IETF protocol assignments, including Teredo 2001::/32
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4, which embeds an IPv4 address
  ['3fff::', 20], // documentation
]

const v4Deny = new BlockList()
for (const [net, prefix] of V4_DENY) v4Deny.addSubnet(net, prefix, 'ipv4')
const v6Deny = new BlockList()
for (const [net, prefix] of V6_DENY) v6Deny.addSubnet(net, prefix, 'ipv6')
const v6GlobalUnicast = new BlockList()
v6GlobalUnicast.addSubnet('2000::', 3, 'ipv6')

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !v4Deny.check(address, 'ipv4')
  if (family === 6) return v6GlobalUnicast.check(address, 'ipv6') && !v6Deny.check(address, 'ipv6')
  return false
}

const LOOPBACK = new Set(['127.0.0.1', '::1'])

// Fixture transport only: the relay's own tests talk to a local server and nothing else.
export function isLoopbackAddress(address: string): boolean {
  return LOOPBACK.has(address)
}
