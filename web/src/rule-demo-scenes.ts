import type { Action, Kind, Piece, Position, Side, Square } from './types.js';

export interface DemoRound {
  actions:[Action,Action];
  intro:string;
  result:string;
  captions?:Record<number,string>;
}
export interface DemoVariant {
  label?:string;
  top?:number;
  pieces:Piece[];
  hands?:Position['hands'];
  activity?:Position['activity'];
  rounds:DemoRound[];
}
export interface DemoScene {
  id:string;
  title:string;
  description:string;
  note?:string;
  variants:DemoVariant[];
}
const piece = (id:string,side:Side,kind:Kind,at:Square):Piece => ({id,side,kind,at,promoted:false,upgraded:false});
const move = (side:Side,id:string,to:Square,choice:'none'|'promote'|'upgrade' = 'none'):Action => ({type:'move',side,piece:id,to,choice});
const idle = (side:Side,back = false):Action => move(side,side+'K',[back ? 9 : 8,side === 'A' ? 9 : 1]);

/** These are real 9×9 positions, viewed through a 5×5 window. Kings outside the
 * window make the otherwise unrelated action; neither player receives a pass. */
export function demoPosition(variant:DemoVariant):Position {
  const kings = [piece('AK','A','K',[9,9]),piece('BK','B','K',[9,1])];
  return {
    pieces:[...kings.filter(king => !variant.pieces.some(p => p.id === king.id)),...variant.pieces],
    hands:variant.hands ?? {A:{},B:{}},activity:variant.activity ?? {},
    dropBans:[],moveBans:[],nextPieceId:0,
  };
}

// Start with simultaneous resolution, then explain rank changes, conditional
// movement, drops and victory. Related outcomes alternate within one topic.
export const demoScenes:DemoScene[] = [
  {
    id:"simultaneous",title:"双方が一手ずつ選び、同時に動く",
    description:"各ラウンド、双方が相手の今回の手を知らずに一手ずつ選びます。両方の手が揃うと、同じ開始局面から同時に動きます。飛・角・香は1段階に1マスずつ進み、桂の跳躍は1段階で着地します。",
    note:"先に入力した側が先に動くわけではありません。毎ラウンド一手を選び、独立したパスはできません。",
    variants:[{pieces:[piece('AP','A','P',[6,6]),piece('BP','B','P',[4,4])],rounds:[{
      actions:[move('A','AP',[6,5]),move('B','BP',[4,5])],
      intro:'まずは、あなたの駒と移動先を選びます。',result:'双方の一手が揃うと、同時に動きます。',
    }]}],
  },
  {
    id:"rank",title:"動く駒同士は高い格が勝ち、同格なら相討ち",
    description:"動く駒同士が衝突すると、格の高い方が相手を取り、その場で停止します。同じ格なら両方が消え、互いに相手の駒を持ち駒へ加えます。",
    note:"基本の格：王・玉 0 ／ 歩 1 ／ 香 2 ／ 桂 3 ／ 銀 4 ／ 金 5 ／ 飛・角 6。",
    variants:[
      {label:"格が違うとき",pieces:[piece('AS','A','S',[6,6]),piece('BP','B','P',[5,4])],rounds:[{
      actions:[move('A','AS',[5,5]),move('B','BP',[5,5])],intro:'銀も敵の歩も、中央の同じマスを指定します。',result:'銀の格4 ＞ 歩の格1。銀が勝ち、ここで停止。',
    }]},
      {label:"同じ格のとき",pieces:[piece('AP','A','P',[5,6]),piece('BP','B','P',[5,4])],rounds:[{
      actions:[move('A','AP',[5,5]),move('B','BP',[5,5])],intro:'両方の歩が、同じマスへ向かいます。',result:'格1 対 格1。同格なので、両方が消えます。',
    }]},
    ],
  },
  {
    id:"contact",title:"同じマス・すれ違いで衝突する",
    description:"同じ段階に同じマスへ入るか、互いの直前のマスを交換すると衝突します。軌跡がマスの間で交差するだけなら、そのまま通過。別の段階に同じマスを通っても衝突しません。",
    variants:[
      {label:"すれ違いは衝突",pieces:[piece('AP','A','P',[5,6]),piece('BP','B','P',[5,5])],rounds:[{
      actions:[move('A','AP',[5,5]),move('B','BP',[5,6])],intro:'両方の歩が、お互いのいたマスを指定します。',result:'位置の交換も衝突。格1 対 格1で、両方が消えます。',
    }]},
      {label:"線の交差だけなら通過",pieces:[piece('AB','A','B',[7,6]),piece('BB','B','B',[4,6])],rounds:[{
      actions:[move('A','AB',[4,3]),move('B','BB',[7,3])],intro:'2枚の角が、交差する斜めの経路を指定します。',result:'線は交差しても、同じマスには入らず双方が到着。',captions:{1:'第1段階：角は隣り合う、別々のマスに。',2:'第2段階：マスの間で軌跡が交差。衝突はしません。',3:'第3段階：それぞれ指定した奥のマスへ到着。'},
    }]},
    ],
  },
  {
    id:"capture",title:"停止中の敵駒は、格に関係なく取れる",
    description:"止まっている敵駒は、相手の格が高くても取れます。相手がこのラウンドに選んでいない駒だけでなく、先に移動を終えた駒や、味方に塞がれて待機している駒も対象です。",
    variants:[{pieces:[piece('AP','A','P',[5,6]),{...piece('BR','B','R',[5,5]),upgraded:true},piece('BG','B','G',[3,4])],rounds:[{
      actions:[move('A','AP',[5,5]),move('B','BG',[4,4])],intro:'格1の歩は、停止中の格7の飛車を指定。相手は別の金を選択。',result:'相手の金が動く間に、歩が格7の飛車を取ります。',
    }]}],
  },
  {
    id:"promotion",title:"成りは動きが変わり、昇格は格が上がる",
    description:"「成り」は動きが変わり、格は元のまま。「昇格」は動きを変えず、格 +1を保持します。敵陣から動くか、実際に敵陣へ到達すると、事前に選んだ変化がラウンド末に適用されます。",
    note:"昇格後は任意では成れません。行き所がなくなる場合だけ強制的に成り、昇格の +1は失います。",
    variants:(['promote','upgrade'] as const).map(choice => ({
      label:choice === 'promote' ? '成り' : '昇格 +1',top:1,pieces:[piece('AP','A','P',[5,4])],rounds:[{
        actions:[move('A','AP',[5,3],choice),idle('B')],intro:'歩を選び、敵陣へ1マス進む手を指定します。',
        result:choice === 'promote' ? '「と」に成ります。動きが変わり、格は1のまま。' : '歩のまま昇格。動きはそのまま、格は1 → 2。',
      }],
    })),
  },
  {
    id:"defense",title:"自陣での衝突は格 +1、青いオーラで表示",
    description:"自陣3段では、動く駒同士の衝突時に格 +1。青いオーラで表示します。自陣の外へ出ると補正がなくなり、青いオーラも消えます。",
    variants:[{top:4,pieces:[piece('AP','A','P',[5,7])],rounds:[{
      actions:[move('A','AP',[5,6]),idle('B')],intro:'自陣にいる歩は青いオーラ。衝突時の格は1 + 1。',result:'自陣を出ると、青いオーラが消えて格1に戻ります。',
    }]}],
  },
  {
    id:"fatigue",title:"2ラウンド続けて動かすと格 −1、休むと回復",
    description:"同じ駒を2ラウンド続けて動かすと、一時的に格 −1（下限0）となり、紫のオーラで表示します。続けて動かしても低下は −1まで。別の駒を動かして1ラウンド休ませると回復し、昇格の +1は失いません。全種類の駒が対象です。",
    note:"格低下中は、自陣の青いオーラより紫を優先して表示します。",
    variants:[{top:2,pieces:[piece('AP','A','P',[5,6]),piece('AC','A','P',[7,6])],rounds:[
      {actions:[move('A','AP',[5,5]),idle('B')],intro:'1ラウンド目。この歩を1マス進めます。',result:'1回目の移動。格1のまま、オーラもまだ通常。'},
      {actions:[move('A','AP',[5,4]),idle('B',true)],intro:'次のラウンドも、同じ歩を続けて動かします。',result:'2ラウンド連続で移動。紫のオーラになり、格1 → 0。'},
      {actions:[move('A','AC',[7,5]),idle('B')],intro:'3ラウンド目は、別の歩を動かして休ませます。',result:'1ラウンド休んだ歩は格1に回復。紫のオーラが消えます。'},
    ]}],
  },
  {
    id:"movement",title:"敵や味方のいるマス、その先も指定できる",
    description:"敵や味方がいるマス、その奥のマスも移動先に指定できます。途中の敵がどけば奥へ進み、残れば取った位置で停止。味方が残る間は、その直前で待ちます。実際の到達位置は、双方の動きで変わります。",
    note:"最初から味方に塞がれていれば0マス移動。その場合も一手としてラウンドを消費します。",
    variants:[
      {label:"敵が横入りする",pieces:[piece('AR','A','R',[5,7]),piece('BG','B','G',[6,4])],rounds:[{
      actions:[move('A','AR',[5,3]),move('B','BG',[5,4])],intro:'飛車は4マス奥を指定。金は途中のマスへ横入り。',result:'金を取った途中のマスで停止。指定した奥へは進みません。',captions:{1:'第1段階：飛車が1マス進み、金が横から入ります。',2:'第2段階：金は停止。飛車はさらに1マス前へ。',3:'第3段階：停止中の金を取って、飛車もここで停止。'},
    }]},
      {label:"敵がどく",pieces:[piece('AR','A','R',[5,7]),piece('BG','B','G',[5,5])],rounds:[{
      actions:[move('A','AR',[5,3]),move('B','BG',[4,5])],intro:'途中に金がいますが、飛車は4マス奥を指定。',result:'金が横へ動いたので、飛車は指定した奥へ到着。',captions:{1:'第1段階：飛車が進み、金は横へどきます。',2:'第2段階：金のいた空きマスを通過。',3:'第3段階：さらに奥へ1マス進みます。',4:'第4段階：指定した奥のマスへ到着。'},
    }]},
      {label:"味方が残る",pieces:[piece('AR','A','R',[5,7]),piece('AG','A','G',[5,5]),piece('BP','B','P',[3,4])],rounds:[{
      actions:[move('A','AR',[5,3]),move('B','BP',[3,5])],intro:'飛車は奥を指定しますが、途中に味方の金。',result:'味方の金が残っているので、飛車は手前で移動終了。',captions:{1:'飛車は1マス進み、相手の歩も前進。',2:'次のマスに味方の金がいるので、ここで待機。'},
    }]},
    ],
  },
  {
    id:"recapture",title:"味方を取った敵を、次の段階で取り返せる",
    description:"指定したマスを塞ぐ味方が敵に取られると、待っていた駒は次の段階にそのマスへ進めます。この「連戦」では、格を比べずに敵を取り返します。",
    variants:[{pieces:[piece('AG','A','G',[5,6]),piece('AP','A','P',[5,5]),piece('BR','B','R',[7,5])],rounds:[{
      actions:[move('A','AG',[5,5]),move('B','BR',[5,5])],intro:'金は味方の歩がいるマスを指定し、待機します。',result:'歩を取った敵の飛車を、次の段階で金が取り返す。',captions:{1:'味方の歩がいるので金は待機。敵の飛車が接近。',2:'敵の飛車が味方の歩を取り、そこで止まります。',3:'マスが空いたので、金が進んで飛車を取り返します。'},
    }]}],
  },
  {
    id:"drop",title:"打った駒は、格によらず盤上の駒に負ける",
    description:"このラウンドに打った駒が、盤上から動く相手の駒と競合すると、格に関係なく取られます。格0の王でも、打ったばかりの格6の飛車を取れます。",
    variants:[{pieces:[piece('AK','A','K',[5,6])],hands:{A:{},B:{R:1}},rounds:[{
      actions:[move('A','AK',[5,5]),{type:'drop',side:'B',kind:'R',to:[5,5]}],intro:'王は前へ。相手は、同じマスに持ち駒の飛車を打つ。',result:'王の格0 ＜ 飛の格6でも、打ち駒の飛車が取られます。',captions:{1:'先に盤上の王が進み、同じマスへの打ち飛車を取ります。'},
    }]}],
  },
  {
    id:"double-drop",title:"同時打ちは格で比べ、同格なら持ち駒に残る",
    description:"双方が同じマスへ同時に打てるときは、格の高い方だけが盤上に残ります。同格なら両方とも不成立となり、持ち駒に残ります。盤上の駒同士の相討ちとは結果が異なります。",
    note:"同格で不成立になった次の1ラウンドは、双方とも同じ駒種を同じマスへ再び打てません。別の種類・別のマスへの打ちは可能です。",
    variants:[
      {label:"格が違う：金と歩",pieces:[],hands:{A:{G:1},B:{P:1}},rounds:[{
      actions:[{type:'drop',side:'A',kind:'G',to:[5,5]},{type:'drop',side:'B',kind:'P',to:[5,5]}],intro:'あなたは金、相手は歩を同じ中央のマスへ打ちます。',result:'金の格5 ＞ 歩の格1。金が残り、歩はあなたの持ち駒に。',
    }]},
      {label:"同じ格：飛と角",pieces:[],hands:{A:{R:1},B:{B:1}},rounds:[{
      actions:[{type:'drop',side:'A',kind:'R',to:[5,5]},{type:'drop',side:'B',kind:'B',to:[5,5]}],intro:'あなたは飛車、相手は角を同じマスへ打とうとします。',result:'飛も角も格6。同格で両方とも不成立、持ち駒に残ります。',
    }]},
    ],
  },
  {
    id:"conditional-drop",title:"敵の移動や二歩の解消を待って打てる",
    description:"敵がいるマスへの打ちや二歩になる打ちも、条件付きで指定できます。同じラウンド中に条件が解消すれば成立。解消しなければ不成立となり、駒は手元に残ります。",
    note:"味方がいるマスへの打ちは指定できません。不成立でも、その一手でラウンドを消費します。",
    variants:[
      {label:"敵がどいて成立",pieces:[piece('BP','B','P',[5,5])],hands:{A:{S:1},B:{}},rounds:[{
      actions:[{type:'drop',side:'A',kind:'S',to:[5,5]},move('B','BP',[5,6])],intro:'敵の歩がいるマスに銀を打つ指定。相手は歩を前へ。',result:'敵の歩がどいた後に、空いたマスへ銀打ちが成立。',
    }]},
      {label:"敵が残って不成立",pieces:[piece('BG','B','G',[5,5]),piece('BP','B','P',[3,4])],hands:{A:{S:1},B:{}},rounds:[{
      actions:[{type:'drop',side:'A',kind:'S',to:[5,5]},move('B','BP',[3,5])],intro:'敵の金のいるマスに銀打ちを指定。相手は別の歩を選択。',result:'金がどかないので、銀打ちは不成立。銀は持ち駒のまま。',
    }]},
      {label:"二歩が解消して成立",pieces:[piece('AP','A','P',[5,5]),piece('BR','B','R',[7,5])],hands:{A:{P:1},B:{}},rounds:[{
      actions:[{type:'drop',side:'A',kind:'P',to:[5,7]},move('B','BR',[5,5])],intro:'同じ筋には自分の歩。新しい歩打ちは二歩の解消を待ちます。',result:'敵の飛車が歩を取り、二歩が解消。指定した歩打ちが成立。',captions:{1:'二歩なので打ちは待機。相手の飛車が1マス進みます。',2:'飛車が歩を取ると二歩が解消し、歩を打てます。'},
    }]},
    ],
  },
  {
    id:"king",title:"王の捕獲で決着、双方が取れば格で判定",
    description:"王手や詰みではなく、王を実際に取ると勝利します。王を取った駒が同じラウンドで取り返されても、勝利は維持。別々の場所で双方の王が取られた場合は、捕獲時の格を比べ、高い側の勝ち、同格なら引き分けです。",
    note:"王手放置・打ち歩詰めの禁止はありません。同一局面の4回反復・200ラウンドで引き分けとなり、そのラウンドの王捕獲を優先します。",
    variants:[
      {label:"王取り後に取り返される",pieces:[piece('AR','A','R',[5,6]),piece('BK','B','K',[5,5]),piece('BR','B','R',[3,5])],rounds:[{
      actions:[move('A','AR',[5,5]),move('B','BR',[5,5])],intro:'あなたの飛車は敵の王を、相手の飛車も中央を指定。',result:'飛車が取り返されても、王を取ったあなたの勝ち！',captions:{1:'先にあなたの飛車が王を捕獲。相手の飛車はまだ途中。',2:'相手の飛車が取り返しても、王を取った勝利は維持。'},
    }]},
      {label:"双方が王を取る",pieces:[piece('AR','A','R',[7,6]),piece('BK','B','K',[7,5]),piece('BG','B','G',[3,4]),piece('AK','A','K',[3,5])],rounds:[{
      actions:[move('A','AR',[7,5]),move('B','BG',[3,5])],intro:'左右の別々の場所で、双方が敵の王を狙います。',result:'両方の王を捕獲。飛の格6 ＞ 金の格5で、あなたの勝ち。',
    }]},
    ],
  },
];
