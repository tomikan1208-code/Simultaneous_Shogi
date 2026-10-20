import type { Event, Piece, Resolution, Side } from './types.js';
import { escape, findPiece, pieceMarkup, rank, symbols } from './presentation.js';

export interface Clash { title:string; detail:string; pieces:Piece[]; ranks:number[]; winner:Side|null; retained:boolean }
const samples = {
  move:new URL('./audio/piece-place.wav',import.meta.url),
  clash:new URL('./audio/clash.wav',import.meta.url),
};
type SampleKind = keyof typeof samples;
/** Visuals follow the resolver's winner/reason; they never adjudicate by rank. */
export function describeClash(event:Event,resolution:Resolution):Clash|null {
  if (event.type === 'contact') {
    const pieces = (event.actors ?? []).map(id => findPiece(resolution,id)).filter((p):p is Piece => !!p);
    if (pieces.length !== 2) return null;
    return { title:event.winner ? '衝突' : '相討ち', detail:event.reason === 'rank' ? '動く駒同士、格で勝負' : event.reason === 'chain' ? '味方除去による連戦' : '停止駒への通常捕獲', pieces, ranks:event.ranks ?? pieces.map(rank), winner:pieces.find(p => p.id === event.winner)?.side ?? null, retained:false };
  }
  if (event.type !== 'drop_duel' && event.type !== 'equal_drop_failure') return null;
  const drops = resolution.actions.filter(action => action.type === 'drop');
  if (drops.length !== 2) return null;
  const pieces:Piece[] = drops.map(action => ({ id:`drop:${action.side}`, side:action.side, kind:action.kind, at:action.to, promoted:false, upgraded:false }));
  const winner = findPiece(resolution,event.winner ?? undefined)?.side ?? (event.winner?.endsWith(':A') ? 'A' : event.winner?.endsWith(':B') ? 'B' : null);
  return { title:'同時打ち', detail:event.type === 'equal_drop_failure' ? '同格のため、双方の持ち駒を保持' : '同じマスへの打ち込み', pieces, ranks:pieces.map(rank), winner, retained:event.type === 'equal_drop_failure' };
}
export class Effects {
  private skipped = false;
  private release:(()=>void)|null = null;
  private audio:AudioContext|null = null;
  private buffers = new Map<SampleKind,Promise<AudioBuffer|null>>();
  private voices = new Set<AudioBufferSourceNode>();
  private audioEpoch = 0;
  constructor(private reduced:()=>boolean,private audible:()=>boolean) {}
  begin():void { this.skipped = false; }
  skip():void { this.skipped = true; this.release?.(); }
  /** Run inside a pointer/keyboard gesture, before asynchronous engine work. */
  unlockAudio():void {
    const ctx = this.context(); if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    for (const kind of ['move','clash'] as SampleKind[]) void this.sample(ctx,kind);
  }
  syncAudio():void {
    if (this.audible()) return;
    this.audioEpoch++;
    for (const voice of this.voices) { try { voice.stop(); } catch { /* Already finished. */ } }
    this.voices.clear();
  }
  private context():AudioContext|null {
    if (!this.audible() || typeof AudioContext === 'undefined') return null;
    try { return this.audio ??= new AudioContext(); } catch { return null; }
  }
  private sample(ctx:AudioContext,kind:SampleKind):Promise<AudioBuffer|null> {
    let cached = this.buffers.get(kind);
    if (!cached) {
      cached = fetch(samples[kind]).then(response => {
        if (!response.ok) throw new Error('Audio unavailable');
        return response.arrayBuffer();
      }).then(bytes => ctx.decodeAudioData(bytes)).catch(() => { this.buffers.delete(kind); return null; });
      this.buffers.set(kind,cached);
    }
    return cached;
  }
  private async playSample(ctx:AudioContext,kind:SampleKind):Promise<void> {
    const epoch = this.audioEpoch, buffer = await this.sample(ctx,kind);
    if (!buffer || !this.audible() || epoch !== this.audioEpoch) return;
    try {
      const source = ctx.createBufferSource(), gain = ctx.createGain();
      source.buffer = buffer; gain.gain.value = kind === 'move' ? .8 : .75;
      source.connect(gain); gain.connect(ctx.destination); this.voices.add(source);
      source.onended = () => { this.voices.delete(source); source.disconnect(); gain.disconnect(); };
      source.start();
    } catch { /* Audio output can disappear while a game is open. */ }
  }
  async wait(ms:number):Promise<void> {
    if (this.skipped) return;
    await new Promise<void>(resolve => {
      const finish = ():void => { clearTimeout(timeout); this.release = null; resolve(); };
      const timeout = setTimeout(finish,ms); this.release = finish;
    });
  }
  async clash(event:Event,resolution:Resolution,names:Record<Side,string>):Promise<void> {
    const data = describeClash(event,resolution); if (!data || this.skipped) return;
    const actor = (p:Piece,i:number):string => `<div class="clash-actor ${i ? 'right' : 'left'} ${data.retained ? '' : !data.winner || p.side !== data.winner ? 'loser' : 'winner'}"><div class="clash-name">${escape(names[p.side])} · ${p.side}</div>${pieceMarkup(p)}<div class="clash-rank">${symbols[p.kind]} · 格 ${data.ranks[i]}</div><div class="clash-verdict">${data.retained ? '持ち駒を保持' : data.winner === p.side ? '勝利' : data.winner ? '被捕獲' : '相討ち'}</div></div>`;
    const overlay = document.getElementById('clash-overlay')!;
    document.getElementById('clash-content')!.innerHTML = `${actor(data.pieces[0],0)}<div class="clash-center"><p class="overline">${data.retained ? 'DOUBLE DROP' : 'SIMULTANEOUS CLASH'}</p><h2${data.title.length > 3 ? ' class="long-title"' : ''}>${data.title}</h2><p>${data.detail}</p></div>${actor(data.pieces[1],1)}`;
    overlay.hidden = false; document.getElementById('skip-effects')?.focus({preventScroll:true}); this.sound('clash');
    await this.wait(this.reduced() ? 1000 : 1750); overlay.hidden = true;
  }
  sound(kind:'move'|'clash'|'win'|'lose'|'draw'|'start'):void {
    const ctx = this.context(); if (!ctx) return;
    try {
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
      if (kind === 'move' || kind === 'clash') { void this.playSample(ctx,kind); return; }
      const tones = kind === 'win' ? [523,659,784,1046] : kind === 'lose' ? [330,277,220] : kind === 'draw' ? [440,523] : [392,523];
      tones.forEach((frequency,i) => {
        const oscillator = ctx.createOscillator(), volume = ctx.createGain();
        const start = ctx.currentTime+i*.09, duration = .25;
        oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(frequency,start);
        volume.gain.setValueAtTime(.0001,start); volume.gain.exponentialRampToValueAtTime(.055,start+.008); volume.gain.exponentialRampToValueAtTime(.0001,start+duration);
        oscillator.connect(volume); volume.connect(ctx.destination); oscillator.start(start); oscillator.stop(start+duration);
        oscillator.onended = () => { oscillator.disconnect(); volume.disconnect(); };
      });
    } catch { /* Sound is optional when the device has no audio output. */ }
  }
}
