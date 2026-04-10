# PCC/CBF v3.2.0（最終決定版）

## Cache Nexus + ECK（Consistency Kernel）統合

狙いは1つだけ：**「集めた資産を、速く・安全に・再現可能に "発火" させる」**。
そのために **PCC（資産化）** と **CBF（逸脱監査）** と **ECK（進化・修復カーネル）** を、1本の運用パイプラインに統合する。

> ちなみに「M3 Ultra = 512GBユニファイドメモリ/819GB/s」は、Appleの仕様としてそういうレンジが出てる（構成による）扱いでOK。

---

## 0) 絶対ルール（これだけ守れば爆発しない）

### 真実の扱い

* **L1（Skill）は「PASSした事実」だけ**（＝実行可能な資産）
* **V3のみ自律実行OK**（CI/公式テスト相当の通過）
* **V2は"隔離実行のみ"**（参照・検証・サンドボックス用途）
* **V1は保管だけ**（実行パスに入れない）

### キャッシュの扱い

* **L2（KV）は知識ではなく加速**。当たれば速い、外れても壊れない
* **KVはモデル依存**。`model_fingerprint` 不一致は即捨て
* **L2はホットセット限定**（全知識常駐は禁止）
* **起動時プリフィルはしない（Lazy）**：最初に当たったドメインだけ作る

### 運用の扱い

* **運用パスからディスクI/Oを排除**（ただしチェックポイントはディスク保管）
* **依存解決は"コンテナ内"で、ネットは"proxy_only"**（完全オフラインに固執しない）
* **ライセンス不明はデフォルト隔離**（UNKNOWNはFAIL棚）

---

## 1) 3層メモリ階層（Tri-State Memory）

### L0 Reflex（最速で候補を絞る）

* 1bit/2bit Vector + concepts
* 精度は捨てて速度優先 → 真偽はL1で確定

### L1 Skill（真実の保管庫）

* Verified Code + Verifier + Evidence + Toolchain Fingerprint + License
* **ここだけが「実行してよい根拠」**

### L2 KV Turbo（加速装置）

* **ドメイン別 Fat Prefix（300〜1500 tokens目安）**
* **Lazy生成 + LRU/TTL/容量上限**で回す
* "短すぎprefix"は廃止（当たっても速くならない問題が出る）

---

## 2) Neural Packet（最終スキーマ：1行=1資産）

> 人間向け要約は禁止。必要なのは「契約」「証拠」「検証」「実行条件」「再現性キー」。

```json
{
  "id": "repo/skill_name#hash",
  "status": "PASS|FAIL",
  "fail_reason": "LICENSE|VERIFIER|UNSAFE|DEP_UNK|OTHER",

  "repo": "<url>",
  "ref": "<branch|tag|commit>",
  "license": "MIT|Apache-2.0|BSD-3|GPL-3.0|UNKNOWN",
  "evidence": [{"path":"...","lines":"L10-L88"}],

  "toolchain_fingerprint": "runner:<image>@<digest>",
  "deps_lock_ref": "locks://<toolchain>/<id>.lock",
  "model_fingerprint": "mlx-lm:<model>@<quant>@<rev>",

  "trigger": {"concepts":["..."], "vec_bin":"1010..."},

  "skill": {
    "language": "python|js|go|rust",
    "input_spec": "...",
    "output_spec": "...",
    "dependencies": ["requests>=2.31", "pydantic>=2"],
    "code_ref": "code://<id>/part_01.py"
  },

  "exec_profile": {
    "mode": "isolated",
    "timeout_sec": 10,
    "memory_mb": 512,
    "cpus": 0.5,
    "network": "none|proxy_only",
    "fs": "ro+tmpfs",
    "ulimit": {"fsize_kb": 10240, "nproc": 128}
  },

  "verifier": {
    "level": "V1|V2|V3",
    "type": "pytest|npm|cargo|go|script",
    "cmd": "pytest -q",
    "pass_condition": "EXIT_CODE_0"
  },
  "verifier_log_ref": "logs://<run_id>/verify.log",

  "kv": {
    "eligible": true,
    "canonical_prefix_id": "prefix/py_base_v1",
    "kv_ref": "kv://<model>/<prefix>.bin"
  },

  "notes": "罠/制約/互換性のみ（推測は推測と明記）"
}
```

**ポイント**

* `code`をJSONLに直書きしない（巨大化して終わる）→ `code_ref` 分離
* `deps_lock_ref` と `toolchain_fingerprint` はセット（環境が変われば資産の再検証が必要）

---

## 3) Harvester→Verifier→Pack の実行パイプライン（最終形）

### Phase A: Harvest（収集）

* repoスキャン → 候補抽出（関数/モジュール/CLI単位）

### Phase B: Triage（門番：軽量で強い）

* 静的解析で **危険・重すぎ・不明** を落とす

  * 例：外部プロセス実行/ネットワーク直叩き/自己書換え/巨大生成ログ など
* ここで落とすと、V2サンドボックスの燃費が劇的に改善する

### Phase C: Verify（検証：V3狙い、無理ならV2、さらに無理なら隔離棚）

* **言語別ベースイメージ**（All-in-one禁止）

  * `py-base`, `py-ml`, `node`, `rust`, `go` みたいに分割
* 依存解決は **proxy_only** でコンテナ内実行
* **ハード制限**（CPU/メモリ/時間/ファイルサイズ）をランタイムで強制

### Phase D: Pack（資産化）

* PASS/FAIL どちらもJSONLにする（学習・統計・再挑戦に使える）
* ただし **FAILログは薄く、PASSログはローテ**（inode死回避）

---

## 4) L2 "Fat Prefix" の勝ち筋（キャッシュ集め最適解）

### 1) Prefixは「1個」じゃなく「クラスター」

* `prefix/py_base_v1`
* `prefix/py_http_v1`
* `prefix/react_base_v1`
* `prefix/rust_algo_v1`
  みたいに **ドメイン別**に持つ

### 2) Lazy + Hotset（重要）

* 起動時はL0/L1だけ生かす
* **そのprefixが初めて当たった瞬間にKV生成**
* Hotsetは **LRU + TTL + サイズ上限** で回す

### 3) KVの価値基準

* KVに入れるのは **「頻度が高い」「prefixが安定」「V3資産が多い」** クラスターだけ
* 逆に、可変が多い領域（依存やI/Oが散るやつ）はKVに向かない

---

## 5) ECK（Evolutionary Consistency Kernel）統合

PCC/CBFの本質は **「収集→検証→資産化→運用→逸脱監査」** のループ。
ECKの本質は **「変更→検証→逸脱検知→修復→学習」** のループ。
v3.2.0 ではこれを統合する。

### ECK = 運用の背骨（"進化・修復"のカーネル）

* **Risk予測（事前）**：変更/新規repoがコケそうかを確率で出す
* **動的しきい値**：コア領域は厳しく、周辺は緩く
* **Auto-Recovery（Patchflow）**：失敗したら「原因分類→戦略生成→適用→再検証→学習」へ自動遷移
* **履歴インデックス**：過去の失敗パターンを最速参照

> "キャッシュ集め"は、KVだけじゃなく **「成功/失敗の履歴」もキャッシュ** するのが最強。

---

## 6) 圧縮率（現実レンジ）

結論：**"保存したい単位"で決まる**。だから2種類の圧縮率を分ける。

### A) 資産保管（L1）としての圧縮率

* 「repo丸ごと」→「再利用可能なSkill断片だけ」
* 典型：**90〜99%減**（10MB repoから、使えるSkill総量が100KB〜1MB程度になるケースが多い）
* 理由：README/未使用コード/重い依存/例外系の山を捨てるから

### B) 実行時コンテキスト（L0/L2）としての圧縮率

* L0（1bit/2bit）＋prefix KVホットセットだけ常駐
* 典型：**99.9%級まで薄くできる**（"全資産"を常駐させない設計だから）

※実測で一発。`bytes_in / bytes_kept / bytes_hotset / kv_hit_rate / TTFT` をログに入れて回す。

---

## 7) チェックリスト（v3.2.0で全部回収済み）

* [x] `toolchain_fingerprint`（環境が変わったら再検証）
* [x] `deps_lock_ref`（依存解決の再現性）
* [x] `exec_profile`（CPU/RAM/時間/FS/ネットの強制）
* [x] Triage（V2サンドボックスの燃費改善）
* [x] V2とV3の権限分離（事故率を落とす）
* [x] Lazy KV（起動が重くならない）
* [x] LRU/TTL/容量（メモリが溶けない）
* [x] ライセンス隔離（UNKNOWN/強いコピーレフト）
* [x] ログ運用（inode死回避）
* [x] Golden Packet（環境異常を早期検出）
* [x] 履歴インデックス（ECKの学習ループ）

---

## 8) 実装順序（最短パス）

1. **Runner（サンドボックス）を先に作る** — `exec_profile` をハード制限として強制できることが最重要
2. **V3の定義を固定**（何をもってV3とするか）
3. **JSONLのLedgerを確定**（上のスキーマを正本にする）
4. **L0 Indexer**（vec_bin生成）
5. **Prefixクラスタ設計**（py/node/rustの3つから開始）
6. **Lazy KV Builder**（Hotsetのみ）
7. 最後に **ECK（Auto-Recovery + 学習）** を接続
