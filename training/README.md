# AI学習コントロールパネル

## 既存AIとの通常対戦・定期評価・蒸留

設定の「既存AIとの対戦・教師データ」で有効化できます。未準備なら同じ画面の「既存AIを準備」でWindows用の公開エンジン・評価関数を取得します。既定は2,000ノード、自己対戦に混ぜる対局割合25%、定期評価8ペア。すべて画面で変更でき、保存後の開始・再開から反映します。外部エンジンをまだ導入していない環境でも既存の学習が使えるよう、配布設定では無効です。このPCの本命実行には有効な設定を保存しています。

有効時は、片側を既存AIにした対局を自己対戦へ混ぜ、残りで現在モデル同士・過去モデルとの対局を続けます。既存AI側の未使用の探索教師はリプレイへ混ぜず、現在モデル側のサンプルに実際の対局結果を付けます。今回の相手の着手を現在モデルへ先に知らせることはありません。

通常の評価間隔で、現在モデル同士・最近の学習済みモデルに加えて既存AIとも陣営交換して対戦します。学習中の成績と、重みを固定した定期評価を分けて記録します。進捗・グラフ・世代の詳細・強さと比較から勝率、得点率、勝敗数、対局数、既存AIの着手採用率を確認できます。相手の重み・ノード数・接続方式が変わった成績は別の識別子で集計します。

「教師データを保存する」を有効にすると、完了した既存AI対局を圧縮して保存します。「強さ・比較」→「教師データから蒸留」で、教師データ、引き継ぐモデル・世代、更新回数、CPU/GPUを選んで実行できます。元のモデルを保持した別モデルができ、その後も通常の評価・自己対戦へ進められます。蒸留は学習・評価を停止してから実行してください。

世代JSONの `self_play.external_ai` に学習中の成績、`evaluation` の `external_usi` に定期評価を保存します。教師データは `evidence/gNNNN-external-training-teacher.jsonl.gz` と `evaluations/gNNNN/external_usi-teacher.jsonl.gz`。どれも確定世代とともに残り、結果ZIPへ含まれます。CLI互換の入口と測定条件は [EXTERNAL_SHOGI.md](../EXTERNAL_SHOGI.md) を参照してください。

## 現在のルールと保存データ

本命は `D+ALL2-C1`（全駒が連続2回目から一時的に格−1、休むと回復、自陣3段で衝突時のみ+1）。旧ルールG169の重みから `dashboard/runs/main-ALL2-C1-from-g0169` を開始します。ルール変更による移行では重みだけを継承し、最適化器・乱数・リプレイは新しくします。旧ルールのG1〜G169とは別実験として記録し、同じグラフへ混ぜません。

確定済み世代の損失、対局ラウンド数、終了理由、格7の指標は停止後も残ります。同じルールでの状態継続では、親の確定済み記録をたどってグラフと世代表をつなげます。停止時に破棄されるのは未確定の世代です。「世代の記録」の行を選ぶと指標・当時の学習条件・評価結果・棋譜を表示し、世代JSONも保存できます。ダッシュボードの結果ZIPには継続前の世代記録と棋譜も含めます。

## 旧ルールの継続記録

旧 `D+B2-C1` は比較実験のG1〜G50、`dashboard/runs/main-DPB2-C1-from-g0050` のG51〜G160、`dashboard/runs/continued-1792501129163` のG161〜G169に分かれています。「本命：2回目から格低下＋自陣+1 · G169」を選ぶと全区間をつないで表示します。新しい全駒ルール用モデルからも「移行前の記録を見る」で戻れます。「学習開始」は新規モデルを作る操作、「再開」は選んだ実行を続ける操作です。

停止・再開は重みだけでなく、AdamW・AMP・乱数・リプレイを復元します。STOPは自動解除し、RUNNINGはPIDが終了済みの場合だけ解除します。設定ファイルを省略すると保存設定を使います。コード更新後は `source.zip` を検証し、保存時のソースで厳密に再開します。保存時の評価方法も維持するため、新しい評価方法で続ける場合は「この状態を引き継ぐ」を使います。

設定画面で保存した値は、次の「再開」にも適用します。対局数・同時対局数・候補数・バッチサイズ・更新回数・評価条件・実行先などを変更でき、実行中は停止してから再開すると反映されます。ルール、モデル形式、リプレイ方針など画面にない条件は元の実行を維持します。現在の条件と次回の条件が違う場合は画面に表示し、`manifest.json` の `config_history` に変更内容と適用開始世代、各世代のJSONに実際の `config` を残します。

古いソースで保存した実行の学習条件を変更する場合は、全学習状態を復元した継続用実行を自動作成し、画面も継続先へ切り替えます。元の実行は残り、重みだけからの再学習にはなりません。世代数は通算の終了世代です。続けるには現在の世代より大きい値か0を指定してください。CLIでも `--resume --config 設定.json` で同じ変更が可能です。

「この状態を引き継ぐ」は、世代番号と全学習状態を保った別の実行を準備します。親の世代・重みハッシュを記録し、元の実行を残します。ルール・モデル形式・学習設定の互換性を検証し、G0・開始時モデルを過去相手から除きます。準備後に「再開」で次の世代へ進めます。有限世代の計画を完了した後の「再開」も、全状態を保った継続用実行を自動で作ります。

```powershell
.venv\Scripts\python.exe -m training.train --run-dir dashboard/runs/main-DPB2-C1-from-g0050 --resume --until-generation 75
.venv\Scripts\python.exe -m training.train --run-dir dashboard/runs/my-next --continue-from dashboard/runs/my-training --prepare-only
```

新しい定期評価は、現在モデル同士の `adapted_self` と最近の学習済みモデルへの `recent_checkpoint`、既存AIを有効にした場合の `external_usi`。旧固定方策・開始時モデルへの定期評価と旧champion昇格判定は行いません。最近のモデルは25世代区切りで選び、相手世代も記録します。自己対戦の得点率50%は棋力の根拠にせず、引き分け・対局長・格7の挙動を確認します。以下の旧champion説明は過去ログの読み方です。

G75・G100などの節目で「ルール比較」から最新重みを分岐できます。短期は同じ重み、長期は全条件に同じ追加学習量を与えて比較します。「進める条件」で1条件だけ選べます。並列数の既定は1で、複数条件は順番に進めます。ルールを変える分岐では重みだけを渡し、optimizer・リプレイを混ぜません。

通常の学習コードは高速化版に統合済みです。ダッシュボード、CLI、Colab用ソースZIPは同じ `training/` と `crates/` を使用します。候補局面の疎な特徴量転送、81bit経路マスク、Rustの混合戦略ソルバー、GPU上の損失一括計算を標準で使用します。実測は [高速化の比較](../benchmarks/training-performance/PERFORMANCE.md) を参照してください。

ゲーム本体とは別に、`dashboard/start.bat` をダブルクリックすると、参考のMAZEWARDと同じ構成の専用ウィンドウが開きます。`npm run dashboard` も同じ動作です。ChromeまたはEdgeのアプリモードを使用し、通常のタブやアドレスバーは表示しません。閲覧にPythonやGPUは不要です。ブラウザで使う場合は `npm run dashboard:server` → **http://localhost:5180**。

## ローカルGPUで学習

1. 初回のみ `dashboard/setup-gpu.bat` を実行。プロジェクトの `.venv` にCUDA版PyTorchを導入します。NVIDIAドライバーが必要です。
2. `dashboard/start.bat` を開き、右上の設定で「Local GPU（CUDA）」と世代数・対局数を保存。
3. 「▶ 学習開始」。自己対戦の盤面処理は並列Rust、ニューラルネットの推論と更新はGPUで実行します。
4. 「■ 停止」またはウィンドウを閉じて停止。確定済み世代から「再開」できます。進行中の世代は破棄されます。

既定の世代数は **0（無制限）**。20世代で停止せず、停止操作まで評価と保存を挟みながら続きます。0のまま再開すると、保存した次の世代から継続します。回数を指定した実験だけ、正の世代数を設定してください。CPUの短い動作確認は1世代で完了します。

既定はGPUを明示指定し、GPUが使用できない場合は開始を止めて環境設定を案内します。CPUへ黙って切り替えません。「自動」を選んだ場合だけCUDA検出で切り替えます。設定画面のGPU表示は実際のCUDA行列演算を確認した結果です。「詳細」でPython・PyTorch・CUDAを確認できます。

このPCはRTX 3050 / 8 GB、PyTorch 2.11.0+cu128（公式Windowsホイール）を使用します。ローカル設定は `dashboard/local.json`、起動エラーは `.cache/dashboard/launcher.log`。初期ポート5180が使用中の場合は空きポートを選びます。ウィンドウ用プロファイルは普段のChrome/Edgeと独立しています。

## 最初に使う

1. ダッシュボードの「Colab・Drive連携」でノートブックと現在のソースZIPを保存する。
2. Google Colabへノートブックをアップロードし、GPUランタイムを選ぶ。最初のセルで `shogi-colab.zip` を渡す。
3. セルを順に実行する。学習はColabの一時ディスク上、確定した世代の保存先は `MyDrive/Simultaneous_Shogi/runs/<RUN_NAME>`。
4. 最終セルで取得した `shogi-results.zip` をローカル画面へ取り込む。Drive for desktopを使う場合は同期した `runs` の絶対パスを画面へ設定する。
5. 世代別成績、損失、処理時間、棋譜、戦術局面を確認する。「棋力の評価・比較」ではモデルをローカルCPUで追加評価できる。

ソースZIPにはRust核・CLI・学習コード・ルール・ノートブックを含めます。ColabにローカルPCへのトンネルを公開する操作はありません。ローカル画面は取得済みのファイルを読みます。進行中のColabの世代を逐次遠隔操作する機能はありません。

## ローカル実行の準備

Python 3.11以上、Rust、Node.js 20以上を使用します。ローカルGPUは上のセットアップを使用し、Colabでは付属のPyTorch/CUDAを使います。CPUのみの検証環境の作成例：

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install numpy torch --index-url https://download.pytorch.org/whl/cpu
npm run ai:build
npm run dashboard
```

Windowsの `python` がMicrosoft Storeのエイリアスを指す場合は、インストール済みPythonのフルパスで最初のコマンドを実行します。このPCでは `C:\Users\tomik\AppData\Local\Programs\Python\Python311\python.exe` で仮想環境を作成・検証しました。ダッシュボードは `.venv` を優先し、`SHOGI_PYTHON` で実行ファイルを指定することもできます。

画面の「CPUで動作確認」は2局・12ラウンド上限・小型モデル・1世代で、学習と4種類の対戦評価の動作を確かめます。この短縮実行は画面で「動作テスト」と表示し、基準モデルの昇格を禁止します。

```powershell
.venv\Scripts\python.exe -m training.train --run-dir dashboard/runs/my-test --smoke
.venv\Scripts\python.exe -m training.train --run-dir dashboard/runs/my-training --config training/config.json
```

ソース更新前の実行から重みを引き継ぐ場合は、新しい保存先と `--init-from` を指定します。モデルの重みと親の識別子を引き継ぎ、最適化器・乱数・リプレイは新規で開始します。引継ぎ元は変更しません。

```powershell
.\start-training.bat --run-dir dashboard/runs/my-training-next --config training/config.json --init-from dashboard/runs/my-training
```

`--resume` は保存設定と、必要なら保存ソースを自動で使用します。異なるソース版の追加評価は保存時のソース一式を使用してください。

価値推論バッチは `value_batch_size`（既定256局面、両陣営512盤面）で設定できます。ダッシュボードの設定APIでも変更可能で、再開時の実行設定として扱います。

正式ルールの版と既定制限は、ビルドしたRustの `training/hello` から取得します。作業中に正式版がv0.5からv0.6へ更新されたため、Pythonに版を固定する実装を廃止しました。v0.6では昇格済みの任意成りが無効、行き場を失う位置の強制成りは有効です。低水準APIで許可された3種類の変更指定は全列挙のままです。

## 学習と計算の配分

`training/config.json` が開始設定です。既定では8環境を2つの永続Rustプロセスに分け、推論はPython側へまとめます。CUDAがあればGPU、なければCPUを実際に使用します。GPU時のみFP16 AMPとTF32を有効にします。GPU利用率を推測して表示することはありません。

各局面で両者の全指定可能手を生成し、ネットの上位候補と探索枠から各4〜8候補を選びます。両者の候補の全組み合わせを正式解決器で1ラウンド進め、終局は正確な勝敗、それ以外は価値ネットで評価します。regret matchingによる平均混合戦略を方策の学習目標にします。**交互着手MCTS、完全ゲームのNash解、最適戦略の保証は実装していません。**

- 深い探索を既定25%の局面に配分し、王への到達候補があれば探索を広げる。探索枠は全候補から抽選し、モデルが低く評価する行動も調べる。
- 完了した対局だけに最終勝敗の価値目標を付ける。途中打ち切りを引き分けと偽って学習しない。
- 過去6チェックポイントからG0・開始時モデルを除いて世代ごとに相手を抽選。既存AIと戦わない残りの対局の既定25%で片側を過去方策とし、その側のサンプルを現在の方策ターゲットに混ぜない。過去相手は探索なしの方策抽選で、現在モデルの探索相手と同じ強さではない。
- 最大4,096局面のリプレイ。直近2世代と全期間の一様抽選を混ぜ、同じ観測・行動特徴量は新しい教師で置換する。TD誤差の優先度付きリプレイは未実装。
- 長い対局からは静かなサンプルを最大96件に制限し、捕獲・衝突局面は保持。左右反転の対称性によるデータ拡張を行う。
- 初期の駒得・王接近の手作り評価は探索の初期補助としてのみ使用し、設定した世代数に応じて0まで減らす。価値の教師は実際の最終結果。
- 評価は初回・既定5世代おき（有限回数の実験は最終回も評価）。重みと再開用状態は毎世代保存。

既定値はColabで測定済みの最適設定ではありません。候補数・環境数・バッチ数を変えて再開した場合は、設定履歴の適用開始世代で区切って比較してください。

## 棋力の評価

同一の候補数・regret反復数・局面評価条件で、陣営を交換した2局を1ペアとします。乱数列は陣営交換後も方策の役割に追従します。混合戦略は評価中も抽選し、単純な最大確率手への置換は行いません。相手の今回の指定は探索へ渡しません。

新しい定期評価は `adapted_self / recent_checkpoint` と、有効時の `external_usi`。最近の学習済み相手がない初回も、既存AIを有効にしていれば自己対戦と既存AIを評価します。勝率は `勝ち / 局数`、得点率は `(勝ち + 0.5 × 引き分け) / 局数`。ペア単位の保守的なHoeffding区間を保存し、相手の世代・エンジン識別子・ノード数と合わせて読みます。複数のモデルへの全般的な優位を保証する値ではありません。

正式なラウンド制限で区間下限が50%を超えたときだけchampionを更新します。学習自体は判定保留でも続きます。単一のchampionに勝つことは、すべての相手への優位や相性循環の解消を保証しません。固定相手ごとの成績も確認します。

無制限学習では、有意水準を小さくし続けても全勝時に昇格判定が可能なよう、基準モデル戦だけ評価ペア数の下限を対数的に増やします。固定3方策の評価ペア数は設定値のままです。

```powershell
.venv\Scripts\python.exe -m training.evaluate --run-dir dashboard/runs/my-training --opponent adapted_self --pairs 64
.venv\Scripts\python.exe -m training.evaluate --run-dir dashboard/runs/my-training --opponent recent_checkpoint --pairs 64
```

結果は `local-evaluations` に保存し、Colabでの昇格記録を変更しません。世代を指定する場合は `--checkpoint 5`、既定は最新です。モデル同士の直接対戦では、双方に同じ探索予算を与えます。固定方策は既存ヒューリスティックなので同じ計算時間ではありません。

## モデルの保存先と選択

ローカル学習の保存先は `dashboard/runs/<実行名>/checkpoints/gNNNN.pt` です。Colabでは `MyDrive/Simultaneous_Shogi/runs/<RUN_NAME>/checkpoints/` に退避します。各実行の `manifest.json` の `latest_checkpoint` が最後に確定した世代、`champion_checkpoint` が対戦評価の基準モデル（初期世代から始まり、昇格条件を満たした世代へ更新）を指します。再開と追加評価は既定で最新を使い、追加評価の `--checkpoint N` で世代を選べます。

ゲーム本体の「AI対戦」から実行名と世代を選び、「モデルを読み込んで対局」で人間と対局できます。最新とchampionを表示し、初期選択は最新。学習中の新しい世代は「一覧を更新」で反映し、進行中の対局は選択したモデルを固定します。Colabの結果は、この画面でZIPを取り込むか、Driveの同期フォルダーを設定するとゲームの一覧にも表示されます。

ゲームサーバーを起動したPCのlocalhostから利用します。ゲームのモデル読み込みは入出力形式・重み・ルールハッシュを検証し、ルール・ラウンド制限が異なる動作確認用モデルは選択できません。学習専用コードの変更に伴うソース識別子の違いは推論時には許容します。学習再開と追加評価のソース一致条件は従来どおりです。基本AIとの対戦機能は削除しました。接続試験は `npm run test:models`。

## 中断・再開と転送

学習の停止は実行フォルダー内の `STOP` またはSIGINTで依頼できます。進行中の世代を破棄し、最後に確定した世代から再開します。モデル・AdamW・AMP scaler・PyTorch/NumPy乱数状態・数値リプレイを保存し、最後にmanifestのポインターを更新します。2世代分のリプレイと全チェックポイントを保持します。

画面・CLIとも、再開時に停止マーカーを自動解除します。設定ファイルを省略すると保存設定を使用します。

```powershell
.venv\Scripts\python.exe -m training.train --run-dir dashboard/runs/my-training --config training/config.json --resume
```

同じ実行への同時書き込みは `RUNNING` の排他作成で防ぎます。終了済みプロセスのマーカーは再開時に自動解除し、生存中・所有者不明の場合は拒否します。Driveへの退避は単一Colabセッションを前提とし、複数マシン間の分散ロックではありません。

Windowsの一時的なファイルロック（WinError 5 / 32 / 33）では、進捗JSON・モデル・リプレイ・Drive退避のアトミック置換を最長5秒まで再試行します。待機中も直前の保存ファイルを維持します。恒久的なアクセス拒否や別種のエラーは通知して停止します。

保存処理修正前の実行を引き継ぐ場合は `python -m dashboard.recover_io --run-dir dashboard/runs/元の実行 --destination dashboard/runs/元の実行-recovered` を使用できます。元のソースZIPと構文を比較し、I/Oの置換呼び出し以外に変更がある場合は拒否します。元データを残し、モデル・最適化器・乱数状態の一致を検証したコピーと復旧記録を作成します。学習アルゴリズムやルールの変更を無視して再開する機能ではありません。

Colabからの再開はノートブックがDriveの確定状態を新しいローカル作業フォルダーへ戻します。`--mirror-dir` は確定世代・停止時・終了時に退避し、manifestを最後にコピーします。各ラウンドの同期書き込みを避けています。Driveの転送失敗時は実行をエラーとして止め、ローカルに残ったチェックポイントを取得して復旧します。

```powershell
.venv\Scripts\python.exe -m training.transfer export --run-dir dashboard/runs/my-training --archive shogi-results.zip
.venv\Scripts\python.exe -m training.transfer import --run-dir dashboard/runs/imported --archive shogi-results.zip
```

ソースが異なる実行の厳密再開には保存 `source.zip` を自動使用します。現行コードでの追加評価には引き続きソース一致が必要です。新しいコードへの全状態継続は別実行に親情報を残し、ルール・モデル形式・学習設定を検証します。チェックポイントは `weights_only=True`、リプレイは `allow_pickle=False` で読みます。

## 原因を調べる・ルールを比較する準備

「棋譜・原因分析」は棋譜全体のハッシュ連鎖をRustで検証してから、ラウンド・段階・捕獲理由を表示します。持ち駒表示はラウンド解決後の値です。王の個数だけで勝敗を推測せず、正式解決器の結果を使います。

自己対戦で捕獲・衝突が起きた最初の最大8局面/世代には、入力局面、双方の候補、利得行列、混合戦略、実際の手、捕獲とイベントを保存します。保存棋譜は世代ごとの代表2局です。全局の棋譜は保存していません。

画面の「候補を広げて再分析」は、選んだ棋譜の当該ラウンド直前までを再実行し、反復履歴を保って最新モデル・16×16候補で探索し直します。元の実際の指定を双方の候補へ必ず含めるので、ネットが低く評価して候補外にした手も分析します。元の学習時の判断との比較では、使用世代・探索量の違いに注意します。

```powershell
.venv\Scripts\python.exe -m training.probe --run-dir dashboard/runs/my-training --replay dashboard/runs/my-training/games/g0001-000.json --round 3 --candidates 16
```

`restricted_gap` は**現在の候補行列の中だけ**の最適応答差です。候補外の反撃、先のラウンド、ネットの誤評価を含む完全ゲームのexploitabilityではありません。強い動きの存在やルール不均衡はこれだけで断定できません。

実行を比較するときはルールハッシュごとに分け、探索予算・種・ソース・ハードウェアを並べて確認します。代替ルールは次の「ルール比較」から独立した実行として学習・評価できます。

## A/B/B+/C/C+/D/D+を比較する

設計と実験計画は [BALANCE_EXPERIMENTS.md](../BALANCE_EXPERIMENTS.md)。ダッシュボードを再起動し、「ルール比較」を開きます。

1. 比較元の実行を選んで「最新世代から比較を作成」。その時点の確定済みチェックポイントとソースを固定します。元の学習実行は変更しません。
2. 「同じ重みで短期比較」で各ルールを評価。初期重みは保存されるため、学習開始後でもこの比較を実行できます。
3. 到達世代を指定して「各ルールで学習」。0は停止まで継続。各ルールは独立したモデル・optimizer・リプレイ・過去相手・championを持ちます。既定は2プロセスを並列実行し、5世代ずつ公平に交代します。全条件を同時に動かす場合は並列数を条件数に設定します。
4. 停止後に「適応後の長期比較」。最新世代を固定し、同じルールに適応したAI同士と初期重みとの陣営交換対戦を行います。
5. 「比較ログZIPを保存」で棋譜・集計・圧縮ラウンドログ・比較元モデル・学習ソースをまとめて渡せます。

ログZIPは全棋譜・全ラウンドの証拠を含み、モデルは初期・最新・champion・明示的な短期/長期比較で使った世代だけを含みます。数値リプレイと途中世代のモデルは元フォルダーに保持し、共有ZIPの肥大化を避けます。学習状態もすべて含める場合はCLIの `export --full-state` を指定してください。

短期と長期は既定で各512ペア（1024局）/条件、異なる評価種を使います。適応中にも5世代おきにchampion・適応モデル同士・初期重みとの評価を保存します。世代番号は分岐後の追加世代で、元の世代は `manifest.parent.generation` に保存します。学習曲線は同じ追加世代・計算予算で比較してください。

CLIの例（Windows以外は `.venv/bin/python` を使用）：

```powershell
.venv\Scripts\python.exe -m training.experiments init --directory dashboard/runs/experiments/balance-001 --source-run dashboard/runs/元の実行 --checkpoint latest
.venv\Scripts\python.exe -m training.experiments run --directory dashboard/runs/experiments/balance-001 --stage short
.venv\Scripts\python.exe -m training.experiments run --directory dashboard/runs/experiments/balance-001 --stage train --generations 50
.venv\Scripts\python.exe -m training.experiments run --directory dashboard/runs/experiments/balance-001 --stage long
.venv\Scripts\python.exe -m training.experiments export --directory dashboard/runs/experiments/balance-001 --output balance-logs.zip
```

停止はダッシュボードの停止ボタンまたは実験ルートの `STOP`。再実行前に実験ルートの `STOP` を削除します。同じ `run --stage train` で確定世代から続けます。失敗した条件がある場合は兄弟の学習にも通常停止を依頼します。実験ルート・子実行の `RUNNING` は同時書き込みを防ぎます。

`init --plan plan.json` の例：

```json
{
  "rules": ["A", "B", "B+", "C", "C+", "D"],
  "rule_overrides": {
    "B": {"consecutiveThreshold": 4},
    "C": {"homeRows": 3, "defensePosition": "round_start", "defenseCap": 7}
  },
  "grid": {
    "movement": ["upgrade_only", "progressive"],
    "consecutiveThreshold": [2, 3, 4],
    "defenseBonus": [1, 2],
    "homeRows": [2, 3, 4],
    "defensePosition": ["round_start", "stage_from", "destination"]
  },
  "seeds": [20261020, 20261021],
  "max_parallel": 2,
  "short_pairs": 512,
  "long_pairs": 512,
  "training": {"device": "cuda", "generations": 0}
}
```

`defenseCap:null` は格7超えを許可、7は上限7です。B+の+1スケールでは8を上限に指定します。D+の格子は指定した有限集合の全組み合わせを列挙し、同一条件を除きます。1計画512組み合わせを超える場合は分割してください。既定10条件ではD+として B+C+、B++C、B++C+、閾値2のB+Cを比較します。

保存先は `dashboard/runs/experiments/<実験名>/`：

| ファイル | 内容 |
| --- | --- |
| `experiment.json`, `configs/` | 比較元の世代・SHA、全条件、学習種、評価種、探索予算 |
| `runs/<条件>/manifest.json` | 追加世代、元モデル、ルール全文と識別子 |
| `runs/<条件>/games/gNNNN-*.json` | 実験の全自己対戦の再検証可能な棋譜 |
| `runs/<条件>/evidence/gNNNN/rounds.jsonl.gz` | 全ラウンドの前後状態、格・疲労、実際の行動、移動成否、衝突、捕獲、候補・混合戦略 |
| `runs/<条件>/evidence/gNNNN/summary.json` | 各局の昇格・生存期間・温存・所有側勝敗と集計 |
| `runs/<条件>/comparisons/short/`, `long/` | 重み固定比較／適応後比較と全評価棋譜 |
| `report.json`, `report.csv` | 短期・長期を分けた比較表。JSONに母数、右打ち切り、陣営交換ペア単位の記述区間 |

未確定世代の記録は学習の根拠に含めません。`manifest.generation` 以下が確定分です。元の54平面モデルは保存ソースの既知v0.6を照合して読み込み、追加8平面の入力重みを0にして62平面へ拡張します。元の重みを上書きせず、新ルールへoptimizerや旧ルールの数値リプレイを持ち込みません。

格7は「永続昇格した飛車・角」で統一します（B+の表示格は8）。終局時生存は右打ち切り、保有側勝率は片側だけ獲得・双方獲得・最初の獲得者・保有ラウンドを区別します。温存率の分母はその局面で少なくとも1段階は進める手があった格7駒ラウンドです。戦略の意図や格7獲得の因果効果はこれだけでは断定しません。

## 千日手に偏る学習への対策

`friendly-attack-guard-v3` は、適用できない成り・昇格の希望を通常移動へまとめ、過去の重みが学んだ移動先のスコアを維持します。エンジンの完全な入力集合や反復4回の判定、勝ち+1・負け−1・引き分け0の報酬は変更しません。

味方駒のいる指定先、または最初の一歩を塞ぐ味方駒に敵の現在の効きがなければ、AIの選択候補から除外します。飛車・角・香の効きは最初の占有マスで止め、桂の跳躍や成り駒の移動形も反映します。相手の未公開の着手は使いません。学習時・評価時・実際の対戦・過去モデル側の候補に同じ制限を適用し、スコアが高くても除外を迂回しません。記録済み棋譜の反実仮想分析では、現在のAI制限で除外した入力もエンジンの合法入力として比較できます。

敵の効きがある味方駒の捕獲を待って動く条件付きの手や、途中まで実際に進める手は保持します。候補の半数を目安に、少なくとも最初の1マスが塞がれていない手を確保し、別の駒の手も比較します。同一局面の2回目からは候補上限を2倍（最大32）に広げます。この制限はAIの選択方針であり、人間の入力・保存棋譜のルールは変えません。

学習時だけ、比較済みの動ける候補を10%混ぜて実行します。探索の教師分布 `strategies` と実行分布 `sampling_strategies` を分けて保存し、対戦・評価ではこの追加探索を使いません。過去モデルの側はそのモデルの通常移動に統合した事前分布を使い、実行確率を `historical_policy` に記録します。既存AIの実着手は `external_policy` に記録し、その側の未使用の探索分布を実行分布や学習教師と偽りません。旧固定方策と学習開始時モデルは引き続き自動対戦相手から除外します。

新しい世代ログには `self_play.search_protocol`、全ラウンド証拠には候補内の移動可能数・AIの選択可能数・除外数・探索率・実行分布を残します。集計では実移動0、双方不動、盤面不変、無効な変更希望、全候補が待機だった回数を追跡できます。敵駒のいる場所への条件付き打ちや、疲労回復のための休息があるため、AIの選択候補は「必ず盤面が動く手」とは一致しません。一律の不動減点は加えていません。探索方法を変えた前後は、ルールが同じでも同一条件の比較として混ぜずに評価してください。

## 構成と検証

| ファイル | 役割 |
| --- | --- |
| `dashboard/server.mjs`, `dashboard/web/` | localhost専用APIと日本語UI |
| `crates/shogi-core/src/training.rs` | 説明文字列を作らない完全行動集合の高速生成 |
| `crates/shogi-core/src/game.rs` | 履歴を含む探索用preview |
| `crates/shogi-cli/src/training.rs` | 永続JSONLバッチ環境・同時候補の解決 |
| `training/features.py`, `model.py`, `search.py` | 相対盤面、疎な行動表現、ネット、同時探索 |
| `training/train.py`, `replay.py`, `evaluate.py` | 自己対戦、再利用、学習、保存、対戦評価 |
| `training/probe.py`, `transfer.py` | 履歴付き局面再分析・ZIP転送 |
| `training/research.json`, `TRAINING_RESEARCH.md` | 一次資料と採用・保留理由 |

```powershell
cargo test --workspace --locked
.venv\Scripts\python.exe -m unittest discover -s tests -p test_training.py -v
npm run test:dashboard
```

Rustの全行動集合・候補順の同値性、300ラウンド、上限・反復を含むpreview一致、混合戦略の既知解、盤面対称性、実学習による重み更新、数値リプレイ保存、中断再開後の更新一致、ZIP転送を検証します。API/DOM結合試験は一時フォルダーで本物のCPU学習を実行し、即時停止・再開・4相手評価・棋譜検証・追加評価・16×16分析・転送・全画面切替を確認します。実ブラウザーの描画確認とColab/CUDAでの実走は、この環境では未実施です。
