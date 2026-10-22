import type { Choice, Kind, Piece, Position, Side, Square } from './types.js';
import { same } from './presentation.js';

export const editorKinds:Kind[] = ['K','R','B','G','S','N','L','P'];
export const handKinds:Kind[] = ['R','B','G','S','N','L','P'];

/** A draft may have missing kings; the match engine validates it on test start. */
export class PositionEditor {
  readonly position:Position;
  tool:'move'|'place'|'erase' = 'move';
  selected:string|null = null;
  side:Side = 'A';
  kind:Kind = 'P';
  state:Choice = 'none';

  constructor(position:Position) {
    this.position = structuredClone(position);
    this.position.dropBans = [];
    this.position.moveBans = [];
    delete this.position.activity;
  }

  get selectedPiece():Piece|undefined { return this.position.pieces.find(piece => piece.id === this.selected); }
  get changeable():boolean { return !['K','G'].includes(this.selectedPiece?.kind ?? this.kind); }

  selectTool(tool:'move'|'erase'):void { this.tool = tool; this.selected = null; }
  selectPiece(id:string):void {
    const piece = this.position.pieces.find(piece => piece.id === id);
    if (!piece) return;
    this.tool = 'move'; this.selected = piece.id; this.side = piece.side; this.kind = piece.kind;
    this.state = piece.promoted ? 'promote' : piece.upgraded ? 'upgrade' : 'none';
  }
  movePiece(id:string,at:Square|null):void {
    const piece = this.position.pieces.find(piece => piece.id === id);
    if (!piece) return;
    this.position.pieces = this.position.pieces.filter(other => other.id !== id && (!at || !same(other.at,at)));
    if (at) { piece.at = [...at]; this.position.pieces.push(piece); }
    this.selectTool('move');
  }
  chooseKind(kind:Kind):void {
    this.tool = 'place'; this.selected = null; this.kind = kind;
    if (!this.changeable) this.state = 'none';
  }
  setSide(side:Side):void {
    this.side = side;
    const piece = this.selectedPiece;
    if (piece) {
      if (piece.kind === 'K') this.removeOtherKing(side,piece.id);
      piece.side = side;
    }
  }
  setState(state:Choice):void {
    this.state = this.changeable ? state : 'none';
    const piece = this.selectedPiece;
    if (piece) { piece.promoted = this.state === 'promote'; piece.upgraded = this.state === 'upgrade'; }
  }
  click(at:Square):void {
    const occupant = this.position.pieces.find(piece => same(piece.at,at));
    if (this.tool === 'erase') {
      this.position.pieces = this.position.pieces.filter(piece => piece !== occupant);
      return;
    }
    if (this.tool === 'place') {
      if (this.kind === 'K') this.removeOtherKing(this.side);
      this.position.pieces = this.position.pieces.filter(piece => !same(piece.at,at));
      let id:string;
      do { id = 'test:'+this.position.nextPieceId++; } while (this.position.pieces.some(piece => piece.id === id));
      this.position.pieces.push({id,side:this.side,kind:this.kind,at:[...at],promoted:this.state === 'promote',upgraded:this.state === 'upgrade'});
      return;
    }
    const selected = this.selectedPiece;
    if (selected) {
      this.movePiece(selected.id,at);
    } else if (occupant) this.selectPiece(occupant.id);
  }
  changeHand(kind:Kind,delta:number):void {
    if (kind === 'K') return;
    const count = Math.max(0,Math.min(40,(this.position.hands[this.side][kind] ?? 0)+delta));
    if (count) this.position.hands[this.side][kind] = count;
    else delete this.position.hands[this.side][kind];
  }
  private removeOtherKing(side:Side,except?:string):void {
    this.position.pieces = this.position.pieces.filter(piece => piece.kind !== 'K' || piece.side !== side || piece.id === except);
  }
}
