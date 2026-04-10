import * as vscode from 'vscode';

/**
 * Perfect Equilibrium Dashboard — VS Code Webview Panel
 * 完全平衡体シミュレータをIDE内で可視化する
 */
export class PEPanel {
  public static currentPanel: PEPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (PEPanel.currentPanel) {
      PEPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'perfectEquilibrium',
      '⚖️ Perfect Equilibrium',
      column || vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    PEPanel.currentPanel = new PEPanel(panel);
  }

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
    this._panel.webview.html = this._getHtmlContent();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  public dispose() {
    PEPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) { d.dispose(); }
    }
  }

  private _getHtmlContent(): string {
    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Perfect Equilibrium Simulator</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0d1117;
      color: #c9d1d9;
      font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
      padding: 16px;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding-bottom: 12px;
      border-bottom: 1px solid #30363d;
      margin-bottom: 16px;
    }
    .header h1 { font-size: 18px; font-weight: 600; }
    .header .badge {
      background: #238636;
      color: white;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
    }
    .grid { display: grid; grid-template-columns: 280px 1fr; gap: 16px; }
    @media (max-width: 700px) { .grid { grid-template-columns: 1fr; } }
    .panel {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 16px;
    }
    .field { margin-bottom: 12px; }
    .field label {
      display: block;
      font-size: 12px;
      color: #8b949e;
      margin-bottom: 4px;
    }
    .field input, .field select {
      width: 100%;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 4px;
      padding: 6px 8px;
      color: white;
      font-family: inherit;
      font-size: 13px;
    }
    .field input:focus, .field select:focus {
      outline: none;
      border-color: #58a6ff;
    }
    .checkbox-field {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }
    .checkbox-field label { font-size: 12px; color: #8b949e; }
    .btn {
      width: 100%;
      padding: 8px;
      border-radius: 6px;
      border: 1px solid rgba(240,246,252,0.1);
      font-family: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .btn-primary { background: #238636; color: white; }
    .btn-primary:hover { background: #2ea043; }
    .btn-secondary { background: #21262d; color: #c9d1d9; margin-top: 8px; }
    .btn-secondary:hover { background: #30363d; }
    .chart-container { height: 300px; margin-bottom: 16px; }
    .status-bar {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
      margin-bottom: 16px;
    }
    .status-card {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 8px 12px;
      text-align: center;
    }
    .status-card .value {
      font-size: 20px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    .status-card .label { font-size: 10px; color: #8b949e; margin-top: 2px; }
    .status-card.green .value { color: #3fb950; }
    .status-card.blue .value { color: #58a6ff; }
    .status-card.red .value { color: #f85149; }
    .status-card.yellow .value { color: #d29922; }
    .cli-output {
      background: #010409;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 12px;
      height: 180px;
      overflow-y: auto;
      font-size: 12px;
      line-height: 1.6;
    }
    .cli-output .info { color: #58a6ff; }
    .cli-output .warn { color: #d29922; }
    .cli-output .error { color: #f85149; }
    .cli-output .success { color: #3fb950; }
    .cli-output .prompt::before { content: "$ "; color: #3fb950; }
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>⚖️ Perfect Equilibrium</h1>
    <span class="badge">v2.0 — Fusion Gate</span>
  </div>

  <div class="grid">
    <!-- Controls -->
    <div class="panel">
      <div class="field">
        <label>Model Preset</label>
        <select id="preset">
          <option value="claude_opus">Claude Opus (e=0.02)</option>
          <option value="claude_sonnet" selected>Claude Sonnet (e=0.04)</option>
          <option value="gemini_pro">Gemini Pro (e=0.12)</option>
          <option value="gemini_flash">Gemini Flash (e=0.18)</option>
          <option value="qwen3_coder">Qwen3 Coder (e=0.06)</option>
          <option value="qwen35_9b">Qwen3.5 9B (e=0.10)</option>
          <option value="custom">Custom</option>
        </select>
      </div>
      <div class="field">
        <label>Error Rate (e)</label>
        <input type="number" id="input-e" value="0.04" step="0.01" min="0" max="1">
      </div>
      <div class="field">
        <label>Correction Power (C_ψ)</label>
        <input type="number" id="input-cpsi" value="0.75" step="0.05" min="0" max="1">
      </div>
      <div class="field">
        <label>Steps</label>
        <input type="number" id="input-steps" value="50" step="10" min="5" max="500">
      </div>
      <div class="field">
        <label>Monte Carlo Agents</label>
        <input type="number" id="input-agents" value="2000" step="500" min="100" max="10000">
      </div>
      <div class="checkbox-field">
        <input type="checkbox" id="toggle-decay">
        <label for="toggle-decay">Context decay: e(t) = e₀ + 0.002t</label>
      </div>
      <button class="btn btn-primary" id="btn-run">▶ Run Simulation</button>
      <button class="btn btn-secondary" id="btn-compare">📊 Compare All Models</button>
    </div>

    <!-- Main -->
    <div>
      <div class="status-bar" id="status-bar">
        <div class="status-card blue"><div class="value" id="val-phall">0.0000</div><div class="label">P_hall</div></div>
        <div class="status-card red"><div class="value" id="val-plimit">—</div><div class="label">P_limit</div></div>
        <div class="status-card green"><div class="value" id="val-status">IDLE</div><div class="label">Status</div></div>
        <div class="status-card yellow"><div class="value" id="val-steps">0</div><div class="label">Steps</div></div>
      </div>
      <div class="panel chart-container">
        <canvas id="chart"></canvas>
      </div>
      <div class="cli-output" id="cli"></div>
    </div>
  </div>

  <script>
    const PRESETS = {
      claude_opus:   { e: 0.02, c: 0.80 },
      claude_sonnet: { e: 0.04, c: 0.75 },
      gemini_pro:    { e: 0.12, c: 0.65 },
      gemini_flash:  { e: 0.18, c: 0.55 },
      qwen3_coder:   { e: 0.06, c: 0.70 },
      qwen35_9b:     { e: 0.10, c: 0.60 },
    };

    let chart = null;

    document.getElementById('preset').addEventListener('change', (ev) => {
      const p = PRESETS[ev.target.value];
      if (p) {
        document.getElementById('input-e').value = p.e;
        document.getElementById('input-cpsi').value = p.c;
      }
    });

    function log(msg, cls = '') {
      const el = document.getElementById('cli');
      el.innerHTML += '<div class="' + cls + '">' + msg + '</div>';
      el.scrollTop = el.scrollHeight;
    }

    function calcLimit(e, c) {
      if (c >= 1 || e === 0) return 0;
      const a = 1 - c;
      return (a * e) / (1 - a * (1 - e));
    }

    function runSim() {
      const e0 = +document.getElementById('input-e').value;
      const cPsi = +document.getElementById('input-cpsi').value;
      const steps = +document.getElementById('input-steps').value;
      const nAgents = +document.getElementById('input-agents').value;
      const decay = document.getElementById('toggle-decay').checked;

      document.getElementById('cli').innerHTML = '';
      log('> run_simulation(e=' + e0 + ', C_ψ=' + cPsi + ', steps=' + steps + ', decay=' + decay + ')', 'prompt');

      const theory = [0], mc = [0];
      let pT = 0;
      const agents = new Uint8Array(nAgents);
      const limit0 = calcLimit(e0, cPsi);

      for (let t = 1; t <= steps; t++) {
        const eT = decay ? e0 + 0.002 * t : e0;
        pT = (1 - cPsi) * (pT + (1 - pT) * eT);
        theory.push(pT);

        let hCount = 0;
        for (let i = 0; i < nAgents; i++) {
          if (agents[i] === 0 && Math.random() < eT) agents[i] = 1;
          if (agents[i] === 1 && Math.random() < cPsi) agents[i] = 0;
          hCount += agents[i];
        }
        mc.push(hCount / nAgents);

        if (t % Math.max(1, Math.floor(steps / 8)) === 0 || t === steps) {
          const lim = decay ? calcLimit(eT, cPsi) : limit0;
          const st = (lim >= 1) ? 'COLLAPSED' : (Math.abs(lim - pT) < 0.0001 ? 'STABLE' : 'EVOLVING');
          const cls = st === 'STABLE' ? 'success' : st === 'COLLAPSED' ? 'error' : 'warn';
          log('[Step ' + t + '] P_theory: ' + pT.toFixed(4) + ' | P_mc: ' + mc[t].toFixed(4) + ' | Limit: ' + lim.toFixed(4) + ' | ' + st, cls);
        }
      }

      const finalLimit = decay ? calcLimit(e0 + 0.002 * steps, cPsi) : limit0;
      document.getElementById('val-phall').textContent = pT.toFixed(4);
      document.getElementById('val-plimit').textContent = finalLimit.toFixed(4);
      document.getElementById('val-steps').textContent = steps;
      const fStatus = finalLimit >= 1 ? 'COLLAPSED' : Math.abs(finalLimit - pT) < 0.001 ? 'STABLE' : 'EVOLVING';
      document.getElementById('val-status').textContent = fStatus;

      renderChart(steps, theory, mc, decay, limit0);
    }

    function renderChart(steps, theory, mc, decay, limit0) {
      const ctx = document.getElementById('chart').getContext('2d');
      if (chart) chart.destroy();

      const labels = Array.from({length: steps + 1}, (_, i) => i);
      const ds = [
        { label: 'Theory P_hall', data: theory, borderColor: '#58a6ff', borderWidth: 2, pointRadius: 0, tension: 0.1, fill: false },
        { label: 'Monte Carlo', data: mc, borderColor: '#3fb950', borderWidth: 1, borderDash: [4,4], pointRadius: 0, tension: 0.1, fill: false },
      ];
      if (!decay) {
        ds.push({ label: 'P_limit (' + limit0.toFixed(4) + ')', data: Array(steps+1).fill(limit0), borderColor: '#f85149', borderWidth: 1, borderDash: [2,2], pointRadius: 0, fill: false });
      }

      chart = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets: ds },
        options: {
          responsive: true, maintainAspectRatio: false,
          animation: { duration: 300 },
          scales: {
            y: { beginAtZero: true, max: decay ? 1 : Math.min(1, Math.max(...theory) * 2), grid: { color: '#21262d' }, ticks: { color: '#8b949e', font: { size: 10 } } },
            x: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', font: { size: 10 }, maxTicksLimit: 10 } }
          },
          plugins: {
            legend: { labels: { color: '#c9d1d9', font: { size: 11 } } }
          }
        }
      });
    }

    function compareModels() {
      document.getElementById('cli').innerHTML = '';
      log('> compare_all_models(steps=100)', 'prompt');
      const steps = 100;
      const results = [];

      for (const [name, p] of Object.entries(PRESETS)) {
        let pT = 0;
        for (let t = 1; t <= steps; t++) {
          pT = (1 - p.c) * (pT + (1 - pT) * p.e);
        }
        const lim = calcLimit(p.e, p.c);
        results.push({ name, e: p.e, c: p.c, p_final: pT, p_limit: lim });
        const cls = lim < 0.03 ? 'success' : lim < 0.06 ? 'warn' : 'error';
        log(name.padEnd(15) + ' e=' + p.e.toFixed(2) + ' C_ψ=' + p.c.toFixed(2) + ' → P_limit=' + lim.toFixed(4) + ' (' + (lim * 100).toFixed(1) + '%)', cls);
      }
      log('────────────────────────────────', 'info');
      log('Lower P_limit = safer model under Vector Proxy supervision', 'info');
    }

    document.getElementById('btn-run').addEventListener('click', runSim);
    document.getElementById('btn-compare').addEventListener('click', compareModels);
    runSim();
  </script>
</body>
</html>`;
  }
}
