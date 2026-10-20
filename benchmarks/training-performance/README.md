# 学習高速化の測定資料

測定した高速化版は、通常の `training/` と `crates/` に統合済みです。ダッシュボード、CLI、Colab用ソースZIPが標準の実装を使用します。起動とモデルの引継ぎは [学習の手順](../../training/README.md)、条件と結果は [PERFORMANCE.md](PERFORMANCE.md) を参照してください。

ルートフォルダーから再測定します。`--run` は毎回新しい保存先を指定します。

```powershell
.venv\Scripts\python.exe scripts/benchmark-training.py --run .cache\benchmark-new --checkpoint dashboard\runs\local-cuda-1792477571336-recovered\checkpoints\g0145.pt --device cuda --generation 145 --eval-pairs 4

.venv\Scripts\python.exe scripts/benchmark-training.py --run .cache\benchmark-balance --checkpoint dashboard\runs\local-cuda-1792477571336-recovered\checkpoints\g0145.pt --device cuda --generation 145 --balance D+B2-C1 --evidence --eval-pairs 4

Expand-Archive -LiteralPath benchmarks\training-performance\benchmark-reference.zip -DestinationPath .cache\training-reference
.venv\Scripts\python.exe scripts/benchmark-training.py --root .cache\training-reference --run .cache\benchmark-before --checkpoint dashboard\runs\local-cuda-1792477571336-recovered\checkpoints\g0145.pt --device cuda --generation 145 --eval-pairs 4
```

`benchmark-results.json` のパスは隔離版を測定した時点の記録です。`optimization.patch` は統合前ソースとの差分、`benchmark-reference.zip` は変更前の凍結ソースです。元の学習結果のソース識別子や保存済みチェックポイントは書き換えていません。
