# AI学習ダッシュボードとColab学習

ゲーム本体とは別に、`npm run dashboard` で **http://localhost:5180** を開きます。`dashboard/start.bat` からも起動できます。ダッシュボードの閲覧にPythonやGPUは不要です。ローカルで学習・評価・結果ZIP取り込みを実行する場合はPythonが必要です。

## 最初に使う

1. ダッシュボードの「Colab・データ連携」でノートブックと現在のソースZIPを保存する。
2. Google Colabへノートブックをアップロードし、GPUランタイムを選ぶ。最初のセルで `shogi-colab.zip` を渡す。
3. セルを順に実行する。学習はColabの一時ディスク上、確定した世代の保存先は `MyDrive/Simultaneous_Shogi/runs/<RUN_NAME>`。
4. 最終セルで取得した `shogi-results.zip` をローカル画面へ取り込む。Drive for desktopを使う場合は同期した `runs` の絶対パスを画面へ設定する。
5. 世代別成績、損失、処理時間、棋譜、戦術局面を確認する。「棋力の評価・比較」ではモデルをローカルCPUで追加評価できる。

ソースZIPにはRust核・CLI・学習コード・ルール・ノートブックを含めます。ColabにローカルPCへのトンネルを公開する操作はありません。ローカル画面は取得済みのファイルを読みます。進行中のColabの世代を逐次遠隔操作する機能はありません。

## ローカル実行の準備

Python 3.11以上、Rust、Node.js 20以上を使用します。GPU学習はColab付属のPyTorch/CUDAを利用します。CPU検証環境の作成例：

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

正式ルールの版と既定制限は、ビルドしたRustの `training/hello` から取得します。作業中に正式版がv0.5からv0.6へ更新されたため、Pythonに版を固定する実装を廃止しました。v0.6では昇格済みの任意成りが無効、行き場を失う位置の強制成りは有効です。低水準APIで許可された3種類の変更指定は全列挙のままです。

## 学習と計算の配分

`training/config.json` が開始設定です。既定では8環境を2つの永続Rustプロセスに分け、推論はPython側へまとめます。CUDAがあればGPU、なければCPUを実際に使用します。GPU時のみFP16 AMPとTF32を有効にします。GPU利用率を推測して表示することはありません。

各局面で両者の全指定可能手を生成し、ネットの上位候補と探索枠から各4〜8候補を選びます。両者の候補の全組み合わせを正式解決器で1ラウンド進め、終局は正確な勝敗、それ以外は価値ネットで評価します。regret matchingによる平均混合戦略を方策の学習目標にします。**交互着手MCTS、完全ゲームのNash解、最適戦略の保証は実装していません。**

- 深い探索を既定25%の局面に配分し、王への到達候補があれば探索を広げる。探索枠は全候補から抽選し、モデルが低く評価する行動も調べる。
- 完了した対局だけに最終勝敗の価値目標を付ける。途中打ち切りを引き分けと偽って学習しない。
- 過去6チェックポイントから世代ごとに相手を抽選。既定25%の対局で片側を過去方策とし、その側のサンプルを現在の方策ターゲットに混ぜない。過去相手は探索なしの方策抽選で、現在モデルの探索相手と同じ強さではない。
- 最大4,096局面のリプレイ。直近2世代と全期間の一様抽選を混ぜ、同じ観測・行動特徴量は新しい教師で置換する。TD誤差の優先度付きリプレイは未実装。
- 長い対局からは静かなサンプルを最大96件に制限し、捕獲・衝突局面は保持。左右反転の対称性によるデータ拡張を行う。
- 初期の駒得・王接近の手作り評価は探索の初期補助としてのみ使用し、設定した世代数に応じて0まで減らす。価値の教師は実際の最終結果。
- 評価は初回・最終回・既定5世代おき。毎世代に大量評価して学習を圧迫しない。重みと再開用状態は毎世代保存。

既定値はColabで測定済みの最適設定ではありません。候補数・環境数・バッチ数を変更した実行は、別のRUN_NAMEで比較してください。

## 棋力の評価

同一の候補数・regret反復数・局面評価条件で、陣営を交換した2局を1ペアとします。乱数列は陣営交換後も方策の役割に追従します。混合戦略は評価中も抽選し、単純な最大確率手への置換は行いません。相手の今回の指定は探索へ渡しません。

固定方策 `hunter / defense / upgrade` と基準チェックポイントに対して評価します。得点率は `(勝ち + 0.5 × 引き分け) / 局数`。ペアを独立単位にした保守的なHoeffding区間を保存し、基準モデルの昇格判定は計画した全判定回数で有意水準を補正します。基準対戦の種も世代ごとに変更します。少ないペア数では「判定保留」が普通で、上達の断定を避けます。固定相手への追加評価を繰り返して最良値を選ぶ場合、その表示区間は多重比較を補正しません。

正式なラウンド制限で区間下限が50%を超えたときだけchampionを更新します。学習自体は判定保留でも続きます。単一のchampionに勝つことは、すべての相手への優位や相性循環の解消を保証しません。固定相手ごとの成績も確認します。

```powershell
.venv\Scripts\python.exe -m training.evaluate --run-dir dashboard/runs/my-training --opponent hunter --pairs 64
.venv\Scripts\python.exe -m training.evaluate --run-dir dashboard/runs/my-training --opponent champion --pairs 64
```

結果は `local-evaluations` に保存し、Colabでの昇格記録を変更しません。世代を指定する場合は `--checkpoint 5`、既定は最新です。モデル同士の直接対戦では、双方に同じ探索予算を与えます。固定方策は既存ヒューリスティックなので同じ計算時間ではありません。

## 中断・再開と転送

学習の停止は実行フォルダー内の `STOP` またはSIGINTで依頼できます。進行中の世代を破棄し、最後に確定した世代から再開します。モデル・AdamW・AMP scaler・PyTorch/NumPy乱数状態・数値リプレイを保存し、最後にmanifestのポインターを更新します。2世代分のリプレイと全チェックポイントを保持します。

画面の再開ボタンは停止マーカーを消してから起動します。CLIで再開する場合は、その実行が停止済みであることを確認して `STOP` を削除し、**同じ設定ファイル**で実行します。

```powershell
.venv\Scripts\python.exe -m training.train --run-dir dashboard/runs/my-training --config training/config.json --resume
```

同じ実行への同時書き込みは `RUNNING` の排他作成で防ぎます。強制終了で残った場合は、既存プロセスの停止を確認してからこのマーカーを削除します。Driveへの退避は単一Colabセッションを前提とし、複数マシン間の分散ロックではありません。

Colabからの再開はノートブックがDriveの確定状態を新しいローカル作業フォルダーへ戻します。`--mirror-dir` は確定世代・停止時・終了時に退避し、manifestを最後にコピーします。各ラウンドの同期書き込みを避けています。Driveの転送失敗時は実行をエラーとして止め、ローカルに残ったチェックポイントを取得して復旧します。

```powershell
.venv\Scripts\python.exe -m training.transfer export --run-dir dashboard/runs/my-training --archive shogi-results.zip
.venv\Scripts\python.exe -m training.transfer import --run-dir dashboard/runs/imported --archive shogi-results.zip
```

ソース・ルール・モデル入出力の識別子が異なる結果は閲覧可能ですが、現在のコードで再評価・再開はしません。各実行の `source.zip` に学習時のコードを保存し、画面から保存できます。異なる版を黙って新ルールとして解釈しません。チェックポイントは `weights_only=True`、リプレイは `allow_pickle=False` で読みます。

## 原因を調べる・ルールを比較する準備

「棋譜・原因分析」は棋譜全体のハッシュ連鎖をRustで検証してから、ラウンド・段階・捕獲理由を表示します。持ち駒表示はラウンド解決後の値です。王の個数だけで勝敗を推測せず、正式解決器の結果を使います。

自己対戦で捕獲・衝突が起きた最初の最大8局面/世代には、入力局面、双方の候補、利得行列、混合戦略、実際の手、捕獲とイベントを保存します。保存棋譜は世代ごとの代表2局です。全局の棋譜は保存していません。

画面の「候補を広げて再分析」は、選んだ棋譜の当該ラウンド直前までを再実行し、反復履歴を保って最新モデル・16×16候補で探索し直します。元の実際の指定を双方の候補へ必ず含めるので、ネットが低く評価して候補外にした手も分析します。元の学習時の判断との比較では、使用世代・探索量の違いに注意します。

```powershell
.venv\Scripts\python.exe -m training.probe --run-dir dashboard/runs/my-training --replay dashboard/runs/my-training/games/g0001-000.json --round 3 --candidates 16
```

`restricted_gap` は**現在の候補行列の中だけ**の最適応答差です。候補外の反撃、先のラウンド、ネットの誤評価を含む完全ゲームのexploitabilityではありません。強い動きの存在やルール不均衡はこれだけで断定できません。

実行を比較するときはルールハッシュごとに分け、探索予算・種・ソース・ハードウェアを並べて確認します。代替ルールの解決器や全ルールを切り替えるUIは未実装です。将来の代替案には別のRuleSet/profileと解決器検証を追加し、既存モデル・棋譜と混在させない構成です。

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
