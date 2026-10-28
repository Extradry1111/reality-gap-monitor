import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AbiCoder, Interface } from 'ethers';
import { evmCallFeed, httpJsonFeed, makeProvider } from '../src/feeds/onchain.js';

const ABI = [
  'function getPrice() view returns (uint256)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function quote(uint256 amountIn) returns (uint256 amountOut)',
];
const iface = new Interface(ABI);

/** Minimal JSON-RPC node that answers eth_call for the three functions above. */
function fakeNode() {
  const coder = AbiCoder.defaultAbiCoder();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const reqs = [].concat(JSON.parse(body));
      const answer = reqs.map(({ id, method, params }) => {
        if (method === 'eth_chainId') return { jsonrpc: '2.0', id, result: '0x1' };
        if (method !== 'eth_call') return { jsonrpc: '2.0', id, error: { code: -32601, message: 'nope' } };
        const tx = iface.parseTransaction({ data: params[0].data });
        let result;
        if (tx.name === 'getPrice') result = coder.encode(['uint256'], [3012_500000000000000000n]); // 3012.5e18
        if (tx.name === 'latestRoundData') result = coder.encode(['uint80', 'int256', 'uint256', 'uint256', 'uint80'], [1, 301250000000n, 0, 0, 1]); // 8 dp
        if (tx.name === 'quote') result = coder.encode(['uint256'], [(tx.args[0] * 3000n) / 10n ** 12n]); // 1 ETH (1e18) -> 3000 USDC (6 dp)
        return { jsonrpc: '2.0', id, result };
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(JSON.parse(body)) ? answer : answer[0]));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const once = (feed) =>
  new Promise((resolve, reject) => {
    feed.once('price', (p) => {
      feed.stop();
      resolve(p.price);
    });
    setTimeout(() => reject(new Error(feed.error ?? 'timeout')), 4000);
    feed.start();
  });

test('evm-call reads view functions, tuple outputs and static-called quotes', async () => {
  const server = await fakeNode();
  const provider = makeProvider('test', { rpc: `http://127.0.0.1:${server.address().port}`, chainId: 1 });
  const address = '0x' + '11'.repeat(20);
  try {
    assert.equal(await once(evmCallFeed({ chain: 'test', address, abi: ABI, method: 'getPrice', decimals: 18 }, provider)), 3012.5);
    assert.equal(await once(evmCallFeed({ chain: 'test', address, abi: ABI, method: 'latestRoundData', resultKey: 'answer', decimals: 8 }, provider)), 3012.5);
    const quoted = await once(
      evmCallFeed({ chain: 'test', address, abi: ABI, method: 'quote', args: ['1000000000000000000'], decimals: 6, divideBy: 1 }, provider),
    );
    assert.equal(quoted, 3000);
    const inverted = await once(evmCallFeed({ chain: 'test', address, abi: ABI, method: 'getPrice', decimals: 18, invert: true }, provider));
    assert.ok(Math.abs(inverted - 1 / 3012.5) < 1e-12);
  } finally {
    provider.destroy();
    server.close();
  }
});

test('http-json reads a nested price', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { pools: [{ price: '42.5' }] } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const feed = httpJsonFeed({ url: `http://127.0.0.1:${server.address().port}/p`, path: 'data.pools[0].price' });
    assert.equal(await once(feed), 42.5);
  } finally {
    server.close();
  }
});
