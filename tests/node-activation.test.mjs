import test from 'node:test';
import assert from 'node:assert/strict';
import { installNodeActivation, HOLD_MS } from '../src/render/nodeActivation.js';

function setup(t, allowed = true, selectable = false) {
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const doc = new EventTarget(), win = new EventTarget();
  win.requestAnimationFrame = () => 1;
  win.cancelAnimationFrame = () => {};
  doc.defaultView = win;
  doc.createElementNS = () => ({setAttribute(){},remove(){}});
  const el = new EventTarget(), attributes = {};
  Object.assign(el, {ownerDocument:doc,__data__:{id:'target'},isConnected:true,
    classList:{add(){}},setAttribute:(k,v)=>attributes[k]=v,
    removeAttribute:k=>delete attributes[k],append(){}});
  const calls = [], selections=[];
  const dispose = installNodeActivation({nodes:()=>[el]}, {
    select:selectable?d=>selections.push(d.id):undefined,
    activate:d=>calls.push(d.id),eligible:()=>allowed,label:()=> 'Open function: target'
  });
  const fire = (target,type,props={}) => {
    const e = new Event(type,{cancelable:true});
    Object.assign(e,{detail:1,pointerId:1,pointerType:'touch',button:0,clientX:0,clientY:0,...props});
    target.dispatchEvent(e); return e;
  };
  const down = (props={}) => {fire(doc,'pointerdown',props);fire(el,'pointerdown',props);};
  t.after(dispose);
  return {doc,win,el,attributes,calls,selections,dispose,fire,down};
}
test('hold activates once, exposes feedback, and suppresses compatibility clicks across cleanup',t=>{
  const h=setup(t);h.down();
  assert.equal(h.attributes['data-holding'],'true');
  t.mock.timers.tick(HOLD_MS);
  assert.deepEqual(h.calls,['target']);
  assert.equal(h.attributes['data-holding'],undefined);
  h.dispose();
  assert.equal(h.fire(h.doc,'click').defaultPrevented,true);
  assert.equal(h.fire(h.doc,'dblclick').defaultPrevented,true);
  h.fire(h.doc,'pointerup');
  t.mock.timers.tick(1001);
  assert.equal(h.fire(h.doc,'click').defaultPrevented,false);
});
for(const type of ['pointerup','pointercancel','lostpointercapture','wheel','scroll','keydown','codeflow:navigation','visibilitychange']){
  test(type+' cancels pending hold',t=>{
    const h=setup(t);h.down();h.fire(h.doc,type);t.mock.timers.tick(HOLD_MS+1);
    assert.deepEqual(h.calls,[]);assert.equal(h.attributes['data-holding'],undefined);
  });
}
test('movement, multi-touch and blur cancel without activation',t=>{
  const h=setup(t);h.down();h.fire(h.doc,'pointermove',{clientX:11});t.mock.timers.tick(HOLD_MS);
  h.fire(h.doc,'pointerup');h.down();h.fire(h.doc,'pointerdown',{pointerId:2});t.mock.timers.tick(HOLD_MS);
  h.fire(h.doc,'pointerup',{pointerId:2});h.fire(h.doc,'pointerup');h.down();h.fire(h.win,'blur');t.mock.timers.tick(HOLD_MS);
  assert.deepEqual(h.calls,[]);
});
test('small pointer jitter is tolerated and teardown cancels pending timers',t=>{
  const h=setup(t);h.down();h.fire(h.doc,'pointermove',{clientX:5,clientY:4});t.mock.timers.tick(HOLD_MS);
  assert.equal(h.calls.length,1);h.fire(h.doc,'pointerup');h.down();h.dispose();t.mock.timers.tick(HOLD_MS);
  assert.equal(h.calls.length,1);
});
test('keyboard activation has a name; mouse hold and unsupported nodes do not activate',t=>{
  const h=setup(t);assert.equal(h.attributes['aria-label'],'Open function: target');
  h.down({pointerType:'mouse'});t.mock.timers.tick(HOLD_MS);assert.equal(h.calls.length,0);
  h.fire(h.el,'keydown',{key:'Enter'});h.fire(h.el,'keydown',{key:' ',repeat:true});
  assert.equal(h.calls.length,1);
});
test('unsupported nodes are labelled disabled and cannot activate',t=>{
  const h=setup(t,false);assert.equal(h.attributes['aria-disabled'],'true');
  h.down();t.mock.timers.tick(HOLD_MS);h.fire(h.el,'keydown',{key:'Enter'});
  assert.deepEqual(h.calls,[]);
});

for (const type of ['resize','orientationchange','pagehide']) {
  test(type+' cancels the active gesture',t=>{
    const h=setup(t);h.down();h.fire(h.win,type);t.mock.timers.tick(HOLD_MS);
    assert.deepEqual(h.calls,[]);
  });
}
for (const type of ['pointerdown','keydown']) {
  test('fresh '+type+' remains usable immediately after hold and teardown',t=>{
    const h=setup(t);h.down();t.mock.timers.tick(HOLD_MS);h.dispose();
    assert.equal(h.fire(h.doc,'click').defaultPrevented,true);
    h.fire(h.doc,type);
    assert.equal(h.fire(h.doc,'click').defaultPrevented,false);
  });
}
test('keyboard-generated click is not swallowed after hold',t=>{
  const h=setup(t);h.down();t.mock.timers.tick(HOLD_MS);h.dispose();
  assert.equal(h.fire(h.doc,'click',{detail:0}).defaultPrevented,false);
});

test('holding beyond one second still suppresses the eventual release click',t=>{
  const h=setup(t);h.down();t.mock.timers.tick(HOLD_MS);h.dispose();
  t.mock.timers.tick(3000);h.fire(h.doc,'pointerup');
  assert.equal(h.fire(h.doc,'click').defaultPrevented,true);
  h.fire(h.doc,'pointerdown',{pointerId:2});
  assert.equal(h.fire(h.doc,'click').defaultPrevented,false);
});

test('unsupported but selectable nodes remain accessible without enabling drill-down',t=>{
 const h=setup(t,false,true);
 assert.equal(h.attributes['aria-label'],'Select function: target');
 assert.equal(h.attributes['aria-disabled'],'false');
 h.down();t.mock.timers.tick(HOLD_MS);assert.deepEqual(h.calls,[]);
 h.fire(h.el,'keydown',{key:'Enter'});
 assert.deepEqual(h.calls,[]);assert.deepEqual(h.selections,['target']);
});
