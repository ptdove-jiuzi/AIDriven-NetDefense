/**
 * 访问器属性守卫（第 5 轮独立复核 P1-1）。
 *
 * 判定必须是其输入的纯函数：同一份请求读两次必须得到同样的值。带 getter 的**普通对象**
 * 能通过 `isPlainObject`，却能在两次读取之间改值，于是一条 `DENY_POLICY_VERSION_STALE`
 * 可以翻成 `allow`（一份在不受支持的策略版本下签发的审批被当成"版本一致"接受），
 * 或者判定按 A 动作算、审计里写 B 动作。
 *
 * `JSON.parse` 产不出访问器，所以拒绝它们不影响真实调用方；这条守卫的作用是把
 * "决策是输入的纯函数"从注明变成可执行的约束。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { baseRequest } from './helpers.js';
import { evaluateResponsePolicy } from '../../packages/response-policy/index.js';

const ALLOW_CODES = new Set(['ALLOWED', 'APPROVAL_REQUIRED']);

describe('accessor properties are rejected before any decision', () => {
  it('denies a request whose policyVersion is a getter', () => {
    const request = baseRequest();
    let reads = 0;
    Object.defineProperty(request, 'policyVersion', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        // 首次读给"支持中的版本"，之后给一个不受支持的版本。
        return reads === 1 ? '1.0' : '9.9';
      },
    });
    const decision = evaluateResponsePolicy(request);
    assert.equal(decision.outcome, 'deny');
    assert.equal(decision.reasonCode, 'DENY_INPUT_INVALID');
    assert.equal(decision.detail?.field, 'policyVersion');
    assert.equal(ALLOW_CODES.has(decision.reasonCode), false);
  });

  it('denies a request whose actionId is a getter, so audit cannot disagree with the decision', () => {
    const request = baseRequest();
    let reads = 0;
    Object.defineProperty(request, 'actionId', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return reads === 1 ? 'observe.record_alert' : 'process.terminate';
      },
    });
    const decision = evaluateResponsePolicy(request);
    assert.equal(decision.outcome, 'deny');
    assert.equal(decision.reasonCode, 'DENY_INPUT_INVALID');
    assert.equal(decision.detail?.field, 'actionId');
    assert.equal(decision.actionId, null, 'a denied request must not carry a decided action id');
  });

  it('denies a setter-only property as well', () => {
    const request = baseRequest();
    Object.defineProperty(request, 'epoch', {
      enumerable: true,
      configurable: true,
      set() {
        // 只写属性：读取恒为 undefined，但同样不是纯数据。
      },
    });
    const decision = evaluateResponsePolicy(request);
    assert.equal(decision.outcome, 'deny');
    assert.equal(decision.reasonCode, 'DENY_INPUT_INVALID');
    assert.equal(decision.detail?.field, 'epoch');
  });

  it('reaches one level into the nested contract DTOs', () => {
    const request = baseRequest({ actionId: 'process.terminate', actorRoles: ['responder'] });
    let reads = 0;
    request.proposal = {
      proposal_id: '33333333-3333-4333-8333-333333333333',
      get action_id() {
        reads += 1;
        return reads === 1 ? 'process.terminate' : 'network.isolate';
      },
    };
    const decision = evaluateResponsePolicy(request);
    assert.equal(decision.outcome, 'deny');
    assert.equal(decision.reasonCode, 'DENY_INPUT_INVALID');
    assert.match(String(decision.detail?.field ?? ''), /^proposal\./u);
  });

  it('still allows an ordinary data-only request through the same path', () => {
    const decision = evaluateResponsePolicy(baseRequest());
    assert.equal(decision.outcome, 'allow');
    assert.equal(decision.reasonCode, 'ALLOWED');
    assert.equal(decision.authorizesExecution, false);
  });
});
