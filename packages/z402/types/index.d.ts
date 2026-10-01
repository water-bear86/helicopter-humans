export type Network = 'zcash:regtest' | 'zcash:testnet'
export interface Identity { publicKey: string; privateKey: string }
export interface Offer {
  version: 1; id: string; network: Network; asset: 'ZEC'; amountZat: string; feeCapZat: string;
  payTo: string; method: 'GET'; url: string; requestHash: string; buyerKey: string;
  responseKey: string; createdAt: number; expiresAt: number;
  profile: 'zally-ironwood-v1'; minimumConfirmations: number;
}
export interface Proof { txid: string; disclosureHex: string }
export interface Evidence {
  cryptographic?: boolean; memoMatch?: boolean; amountMatch?: boolean; recipientMatch?: boolean;
  chainPresent: boolean; confirmations: number; txid: string; outputIndex?: number;
  blockhash?: string; height?: number; experimental?: boolean;
}
export interface Receipt {
  version: 1; merchantKey: string; offer: Offer; offerSignature: string; proof: Proof;
  chain: Evidence & { outputIndex: number }; resourceDigest: string; encryptedDigest: string;
  observedAt: number; signature: string;
}
export interface NativeVerifier { verify(input: { offer: Offer; proof: Proof }): Promise<Evidence> }
export interface WalletBridge extends NativeVerifier {
  propose(input: { offer: Offer; offerSignature: string }): Promise<{pcztHex: string; feeZat: string}>;
  sign(input: { offer: Offer; offerSignature: string; pcztHex: string }): Promise<{pcztHex: string; feeZat: string}>;
  submit(input: { offer: Offer; offerSignature: string; pcztHex: string }): Promise<{txid: string}>;
  disclose(input: { offer: Offer; offerSignature: string; txid: string }): Promise<{disclosureHex: string}>;
}
export type Transport = (url: string, options: {headers: Record<string,string>; purchaseId: string}) => Promise<Response>
export class Z402Error extends Error { readonly code: string; constructor(code: string) }
export function identity(type?: 'ed25519' | 'x25519'): Identity
export function nonce(): string
export class PrivateStore {
  constructor(path: string, key: Buffer, options?: {budgetZat?: string});
  get(id: string): unknown; put(id: string, value: unknown): void;
  reserve(id: string, maximumZat: string): void; charge(id: string, chargedZat: string): void;
  claim(network: Network, txid: string, outputIndex: number, purchase: string): boolean;
  locked<T>(id: string, action: () => Promise<T>): Promise<T>; close(): void;
}
export class NativeWallet implements WalletBridge {
  constructor(options: {binary: string; configFile: string; timeoutMs?: number});
  call(command: 'preflight' | 'init' | 'sync' | 'address' | 'propose' | 'sign' | 'submit' | 'disclose' | 'verify', input?: object): Promise<Record<string,unknown>>;
  preflight(): Promise<Record<string,unknown>>;
  propose: WalletBridge['propose']; sign: WalletBridge['sign']; submit: WalletBridge['submit'];
  disclose: WalletBridge['disclose']; verify: WalletBridge['verify'];
}
export class AgentClient {
  constructor(options: { store: PrivateStore; native: WalletBridge; transport: Transport; merchants: Record<string,string>; maxAmountZat: string; feeCapZat: string });
  purchase(url: string, options: {purchaseId: string}): Promise<Buffer | {status: 'pending'; retrySamePurchase: true}>;
  newPurchaseId(): string;
}
export function createMerchant(options: {
  identity: Identity; store: PrivateStore; native: NativeVerifier; network: Network; payTo: string;
  profile?: Offer['profile']; feeCapZat?: string; minimumConfirmations?: number; quoteTtlMs?: number;
  resources: Record<string,{amountZat: string; read(options: {purchaseId: string}): Promise<Uint8Array>}>;
}): (request: Request) => Promise<Response>
export function verifyReceipt(receipt: Receipt, options: {merchantKey: string; native: NativeVerifier}): Promise<{cryptographic: true; chainPresent: boolean; confirmations: number; meetsConfirmationPolicy: boolean; experimental: true}>
export function torTransport(options?: {proxy?: string; timeoutMs?: number}): Transport
export function regtestTransport(): Transport
