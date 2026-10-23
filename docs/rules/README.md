# ルール実演GIF

リポジトリの [README](../../README.md) に表示する実演です。ゲーム内の `web/src/rule-demo-scenes.ts` と同じ配置・手順を使い、実際のWASMルールエンジンで解決した盤面をブラウザーから録画します。

再生成するには、依存関係とゲームをビルドしてから実行します。

```powershell
npm ci
npm run build
npm run docs:rule-gifs
```

ChromeまたはEdgeを自動検出します。別の実行ファイルを使う場合は `CHROME_PATH` を指定してください。

出力は420×480、2倍速、音なしの無限ループです。生成時にはGIFをブラウザーで再デコードし、先頭・中央・末尾の合成済み画素を照合します。`manifest.json` に各ファイルのサイズ・再生時間・フレーム数・ハッシュを記録します。ルートのREADMEの説明・順序も実演データから更新します。

一つだけ確認するときは `node scripts/build-rule-gifs.mjs --scene=promotion` のように指定します。この場合は該当GIFだけを生成します。
