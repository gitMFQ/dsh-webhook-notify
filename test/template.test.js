/**
 * 模板与请求构造的单元测试。
 *
 * 重点覆盖「自由」的两处硬需求：
 * 1. 自定义 Authorization 头要能原样带出去（浏览器里做不到的那件事）；
 * 2. 正文含换行/引号时，JSON 模板不能被拆坏。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildVars, composeText, render, renderDeep } from '../lib/template.js';
import { buildRequest, makeEvent, parseHeaders } from '../lib/send.js';

const SAMPLE = {
  kind: 'done',
  title: 'DSH · 回复完成',
  body: '第一行\n第二行 "引号"',
  sessionId: 'sess-1',
  time: '2026-10-20T08:00:00.000Z',
};

test('render 替换简单变量', () => {
  assert.equal(render('标题：{{title}}', buildVars({ ...SAMPLE, text: 'x' })), '标题：DSH · 回复完成');
});

test('render 支持嵌套路径与 json 变量', () => {
  const vars = { a: { b: '深层' }, json: '{"k":1}' };
  assert.equal(render('{{a.b}}', vars), '深层');
  assert.equal(render('{{json}}', vars), '{"k":1}');
});

test('render json 模式会转义换行与引号', () => {
  const vars = buildVars({ ...SAMPLE, text: 'a\nb"c' });
  const out = render('{"content":"{{content}}"}', vars, { json: true });
  assert.equal(JSON.parse(out).content, 'a\nb"c');
});

test('render 缺失变量渲染成空串而不是 undefined', () => {
  assert.equal(render('[{{nope.nothing}}]', {}), '[]');
});

test('renderDeep 递归处理对象与数组', () => {
  const vars = { token: 'tk', kind: 'done' };
  const out = renderDeep({ A: '{{token}}', list: ['{{kind}}'] }, vars);
  assert.deepEqual(out, { A: 'tk', list: ['done'] });
});

test('parseHeaders 支持对象与 Key: Value 文本', () => {
  assert.deepEqual(parseHeaders({ A: '1' }), { A: '1' });
  assert.deepEqual(parseHeaders('Authorization: Bearer x\nX-Tag: y'), {
    Authorization: 'Bearer x',
    'X-Tag': 'y',
  });
  assert.deepEqual(parseHeaders('# 注释\nA: 1'), { A: '1' });
});

test('默认 json 载荷带 content 与 text 两个别名', () => {
  const event = makeEvent(SAMPLE, {});
  const request = buildRequest({ url: 'https://example.com/hook' }, event);
  const payload = JSON.parse(request.body);
  assert.equal(payload.source, 'dsh-webhook-notify');
  assert.equal(payload.content, event.text);
  assert.equal(request.headers['Content-Type'], 'application/json; charset=utf-8');
});

test('自定义 JSON 模板保留 Authorization 头且不被换行拆坏', () => {
  const event = makeEvent(SAMPLE, {});
  const request = buildRequest(
    {
      url: 'https://oih.osai.eu.org:8443/bot/v1/message/send',
      headers: 'Authorization: Bearer app_token',
      body: '{"content":"{{content}}"}',
    },
    event,
  );
  assert.equal(request.headers.Authorization, 'Bearer app_token');
  const parsed = JSON.parse(request.body);
  assert.match(parsed.content, /第一行\n第二行/);
});

test('text 模式只发正文并设置纯文本头', () => {
  const event = makeEvent(SAMPLE, {});
  const request = buildRequest({ url: 'https://example.com/h', bodyMode: 'text' }, event);
  assert.equal(request.body, event.text);
  assert.match(request.headers['Content-Type'], /text\/plain/);
});

test('GET 与 none 模式不带请求体', () => {
  const event = makeEvent(SAMPLE, {});
  assert.equal(buildRequest({ url: 'https://e.com/h', method: 'GET' }, event).body, undefined);
  assert.equal(buildRequest({ url: 'https://e.com/h', bodyMode: 'none' }, event).body, undefined);
});

test('composeText 拼接标题正文并追加时间', () => {
  const text = composeText({ ...SAMPLE }, '');
  assert.match(text, /^DSH · 回复完成\n第一行/);
  assert.match(text, /时间：/);
});

test('composeText 支持自定义模板', () => {
  const text = composeText(SAMPLE, '【{{title}}】{{body}}');
  assert.equal(text, '【DSH · 回复完成】第一行\n第二行 "引号"');
});

test('URL 里的模板变量会被替换', () => {
  const event = makeEvent(SAMPLE, {});
  const request = buildRequest({ url: 'https://e.com/h?kind={{kind}}&s={{sessionId}}' }, event);
  assert.equal(request.url, 'https://e.com/h?kind=done&s=sess-1');
});

test('render 不暴露原型链上的属性', () => {
  // 模板由用户编写：{{constructor.name}} 这类路径不该把原型对象带进请求体。
  assert.equal(render('[{{constructor.name}}]', {}), '[]');
  assert.equal(render('[{{__proto__.polluted}}]', {}), '[]');
});

test('renderDeep 与 json 模式对数组/嵌套对象仍正确', () => {
  const vars = buildVars({ ...SAMPLE, text: 'x' });
  const out = renderDeep({ a: ['{{kind}}', { b: '{{title}}' }] }, vars);
  assert.equal(out.a[0], 'done');
  assert.equal(out.a[1].b, 'DSH · 回复完成');
});
