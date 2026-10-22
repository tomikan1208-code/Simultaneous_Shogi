import { square, symbol } from './presentation.js';
import type { Choice, Piece, Side, Square } from './types.js';
import type { PositionEditor } from './test-position.js';

interface EditorBindings {
  editor:()=>PositionEditor|null;
  perspective:()=>Side;
  changed:()=>void;
  markup:(piece:Piece)=>string;
}
interface Drag {
  pointer:number;
  piece:string;
  from:Square;
  startX:number;
  startY:number;
  x:number;
  y:number;
  active:boolean;
}

/** Pointer editing is limited to the draft; the match input stays separate. */
export class TestBoardControls {
  private menuPiece:string|null = null;
  private drag:Drag|null = null;
  private suppressClick = false;

  constructor(private board:HTMLElement,private menu:HTMLElement,private preview:HTMLElement,private bindings:EditorBindings) {
    board.addEventListener('contextmenu',event => this.openMenu(event));
    board.addEventListener('pointerdown',event => this.pointerDown(event));
    board.addEventListener('dragstart',event => { if (bindings.editor()) event.preventDefault(); });
    board.addEventListener('click',event => {
      if (!this.suppressClick || event.detail === 0) return;
      this.suppressClick = false; event.preventDefault(); event.stopImmediatePropagation();
    },true);
    board.addEventListener('lostpointercapture',event => { if (this.drag?.pointer === event.pointerId) this.cancelDrag(); });
    menu.addEventListener('click',event => this.editPiece(event));
    document.addEventListener('pointerdown',event => {
      if (!menu.contains(event.target as Node)) this.closeMenu();
    },true);
    document.addEventListener('pointermove',event => this.pointerMove(event),{passive:false});
    document.addEventListener('pointerup',event => this.pointerUp(event));
    document.addEventListener('pointercancel',event => { if (this.drag?.pointer === event.pointerId) this.cancelDrag(); });
    document.addEventListener('keydown',event => {
      if (event.key !== 'Escape' || !this.drag && !this.menuPiece) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (this.drag) this.cancelDrag();
      else this.dismissMenu();
    },true);
    window.addEventListener('blur',() => this.cancelDrag());
    window.addEventListener('resize',() => { this.cancelDrag(); this.render(); });
    window.addEventListener('scroll',() => { if (this.menuPiece) this.render(); },true);
    document.addEventListener('visibilitychange',() => { if (document.hidden) this.reset(); });
  }

  reset():void { this.closeMenu(); this.clearDrag(); }

  render():void {
    const editor = this.bindings.editor();
    if (!editor) { this.reset(); return; }
    const piece = editor.position.pieces.find(p => p.id === this.menuPiece);
    if (!piece || editor.selected !== piece.id) this.closeMenu();
    else {
      this.menu.hidden = false;
      this.menu.querySelector<HTMLElement>('#test-piece-title')!.textContent = square(piece.at)+' '+symbol(piece);
      for (const button of this.menu.querySelectorAll<HTMLButtonElement>('[data-editor-side]')) {
        button.setAttribute('aria-pressed',String(button.dataset.editorSide === piece.side));
      }
      const state = piece.promoted ? 'promote' : piece.upgraded ? 'upgrade' : 'none';
      for (const button of this.menu.querySelectorAll<HTMLButtonElement>('[data-editor-state]')) {
        button.setAttribute('aria-pressed',String(button.dataset.editorState === state));
        button.disabled = button.dataset.editorState !== 'none' && !editor.changeable;
      }
      const board = this.board.getBoundingClientRect(), width = this.menu.offsetWidth, height = this.menu.offsetHeight;
      const flipped = this.bindings.perspective() === 'B';
      const x = ((flipped ? piece.at[0]-1 : 9-piece.at[0])+.5)/9*board.width;
      const y = ((flipped ? 9-piece.at[1] : piece.at[1]-1)+.5)/9*board.height;
      const left = Math.max(6,Math.min(x+12,board.width-width-6,window.innerWidth-board.left-width-6));
      const top = Math.max(6,6-board.top,Math.min(y+12,board.height-height-6,window.innerHeight-board.top-height-6));
      this.menu.style.left = left+'px'; this.menu.style.top = top+'px';
    }
    if (this.drag?.active) this.markDrag();
  }

  private cell(at:Square):HTMLButtonElement|null {
    return this.board.querySelector<HTMLButtonElement>('[data-x="'+at[0]+'"][data-y="'+at[1]+'"]');
  }
  private atPointer(x:number,y:number):Square|null {
    const rect = this.board.getBoundingClientRect();
    if (!rect.width || !rect.height || x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) return null;
    const col = Math.floor((x-rect.left)/rect.width*9), row = Math.floor((y-rect.top)/rect.height*9);
    return this.bindings.perspective() === 'B' ? [col+1,9-row] : [9-col,row+1];
  }
  private openMenu(event:MouseEvent):void {
    const editor = this.bindings.editor();
    if (!editor) return;
    event.preventDefault();
    const cell = (event.target as HTMLElement).closest<HTMLElement>('[data-x]');
    const piece = cell && editor.position.pieces.find(p => p.at[0] === Number(cell.dataset.x) && p.at[1] === Number(cell.dataset.y));
    this.clearDrag(); this.closeMenu();
    if (!piece) { this.bindings.changed(); return; }
    editor.selectPiece(piece.id); this.menuPiece = piece.id; this.bindings.changed();
    this.menu.querySelector<HTMLButtonElement>('[data-editor-side="'+piece.side+'"]')?.focus({preventScroll:true});
  }
  private closeMenu():void {
    const editor = this.bindings.editor(), piece = editor?.position.pieces.find(p => p.id === this.menuPiece);
    if (this.menuPiece && editor?.selected === this.menuPiece) editor.selected = null;
    if (piece) this.cell(piece.at)?.classList.remove('selected');
    this.menuPiece = null; this.menu.hidden = true;
  }
  private dismissMenu():void {
    const at = this.bindings.editor()?.selectedPiece?.at;
    this.closeMenu(); this.bindings.changed();
    if (at) this.cell(at)?.focus({preventScroll:true});
  }
  private editPiece(event:MouseEvent):void {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button'), editor = this.bindings.editor();
    if (!button || button.disabled || !editor || !this.menuPiece) return;
    if (button.hasAttribute('data-editor-close')) { this.dismissMenu(); return; }
    else {
      editor.selectPiece(this.menuPiece);
      if (button.dataset.editorSide) editor.setSide(button.dataset.editorSide as Side);
      if (button.dataset.editorState) editor.setState(button.dataset.editorState as Choice);
    }
    this.bindings.changed();
  }
  private pointerDown(event:PointerEvent):void {
    if (event.button !== 0 || this.drag) return;
    this.suppressClick = false;
    const editor = this.bindings.editor(), cell = (event.target as HTMLElement).closest<HTMLElement>('[data-x]');
    if (!editor || !cell) return;
    const piece = editor.position.pieces.find(p => p.at[0] === Number(cell.dataset.x) && p.at[1] === Number(cell.dataset.y));
    if (!piece) return;
    this.drag = {pointer:event.pointerId,piece:piece.id,from:[...piece.at],startX:event.clientX,startY:event.clientY,x:event.clientX,y:event.clientY,active:false};
  }
  private pointerMove(event:PointerEvent):void {
    const drag = this.drag, editor = this.bindings.editor();
    if (!drag || drag.pointer !== event.pointerId) return;
    if (!editor || !(event.buttons & 1)) { this.cancelDrag(); return; }
    drag.x = event.clientX; drag.y = event.clientY;
    if (!drag.active) {
      if (Math.hypot(drag.x-drag.startX,drag.y-drag.startY) < 5) return;
      const piece = editor.position.pieces.find(p => p.id === drag.piece);
      if (!piece) { this.clearDrag(); return; }
      drag.active = true; editor.selectTool('move');
      this.board.setPointerCapture(event.pointerId);
      this.preview.innerHTML = this.bindings.markup(piece)+'<span class="test-drag-label"></span>';
      this.preview.style.width = this.board.getBoundingClientRect().width/9*.88+'px';
      this.preview.hidden = false; document.body.classList.add('is-dragging-piece'); this.bindings.changed();
    }
    event.preventDefault(); this.markDrag();
  }
  private markDrag():void {
    const drag = this.drag; if (!drag?.active) return;
    const at = this.atPointer(drag.x,drag.y);
    this.board.querySelector('.editor-drop-target')?.classList.remove('editor-drop-target');
    this.cell(drag.from)?.classList.add('editor-drag-source');
    if (at) this.cell(at)?.classList.add('editor-drop-target');
    this.preview.style.left = drag.x+'px'; this.preview.style.top = drag.y+'px';
    this.preview.classList.toggle('will-delete',!at);
    this.preview.querySelector<HTMLElement>('.test-drag-label')!.textContent = at ? square(at)+'へ移動' : '盤外で削除';
  }
  private pointerUp(event:PointerEvent):void {
    const drag = this.drag; if (!drag || drag.pointer !== event.pointerId) return;
    if (!drag.active) { this.drag = null; return; }
    event.preventDefault(); this.suppressClick = true;
    const editor = this.bindings.editor(), at = this.atPointer(event.clientX,event.clientY);
    if (editor) editor.movePiece(drag.piece,at);
    this.clearDrag(); this.bindings.changed(); this.cell(at ?? drag.from)?.focus({preventScroll:true});
  }
  private cancelDrag():void {
    const active = this.drag?.active;
    if (active) this.suppressClick = true;
    this.clearDrag(); if (active) this.bindings.changed();
  }
  private clearDrag():void {
    const drag = this.drag; this.drag = null;
    if (drag && this.board.hasPointerCapture(drag.pointer)) this.board.releasePointerCapture(drag.pointer);
    for (const cell of this.board.querySelectorAll('.editor-drag-source,.editor-drop-target')) cell.classList.remove('editor-drag-source','editor-drop-target');
    this.preview.hidden = true; document.body.classList.remove('is-dragging-piece');
  }
}
