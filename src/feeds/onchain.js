import { Contract, JsonRpcProvider, Network, formatUnits } from 'ethers';
import { PollingFeed } from './feed.js';
import { applyTransform, fetchJson, getPath } from '../util.js';

export function makeProvider(chainName, chain) {
  if (!chain?.rpc) throw new Error(`chain "${chainName}" has no rpc url (set it in config.json or via env)`);
  // a static network skips eth_chainId probing, so a dead RPC fails fast instead of retrying forever
  const network = chain.chainId ? Network.from(Number(chain.chainId)) : undefined;
  return new JsonRpcProvider(chain.rpc, network, { staticNetwork: network ?? true });
}

/** Pick one output from an ethers call result, then scale a raw integer into a price. */
export function decodeResult(res, { resultIndex, resultKey, decimals = 0 } = {}) {
  let v = res;
  if (resultKey != null) v = res[resultKey];
  else if (resultIndex != null) v = res[resultIndex];
  else if (Array.isArray(res)) v = res[0];
  if (typeof v === 'bigint') return Number(formatUnits(v, decimals));
  return Number(v) / 10 ** decimals;
}

/**
 * Reads a price from any contract view (or static-called) function.
 * spec: { chain, address, abi, method, args, resultIndex|resultKey, decimals, multiply, divideBy, invert, pollMs }
 */
export function evmCallFeed(spec, provider) {
  const abi = Array.isArray(spec.abi) ? spec.abi : [spec.abi];
  const contract = new Contract(spec.address, abi, provider);
  const fn = contract.getFunction(spec.method);
  const label = spec.label ?? `${spec.chain}:${spec.address.slice(0, 8)}…${spec.method}`;
  return new PollingFeed(`evm:${spec.chain}:${spec.address}:${spec.method}:${JSON.stringify(spec.args ?? [])}`, label, spec.pollMs ?? 3000, async () =>
    applyTransform(decodeResult(await fn.staticCall(...(spec.args ?? [])), spec), spec),
  );
}

/** Reads a price from any JSON HTTP endpoint. spec: { url, path, headers, pollMs, multiply, divideBy, invert } */
export function httpJsonFeed(spec) {
  const label = spec.label ?? new URL(spec.url).host;
  return new PollingFeed(`http:${spec.url}#${spec.path ?? ''}`, label, spec.pollMs ?? 3000, async () => {
    const raw = getPath(await fetchJson(spec.url, { headers: spec.headers }), spec.path);
    if (raw == null) throw new Error(`path "${spec.path}" not found in response`);
    return applyTransform(raw, spec);
  });
}
