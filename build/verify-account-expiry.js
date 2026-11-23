'use strict';
/**
 * 微软账号「假过期」修复验收
 *
 * 用户报：主界面显示「微软账号已过期」，但账号明明还能用。
 *
 * 根因（两层）：
 *   ① 主进程把 accessToken 到期时间**写死成 12 小时**
 *      （服务端真实返回 expires_in = 86400 秒），
 *      于是登录满 12 小时界面就开始谎报。
 *   ② 更关键：**accessToken 过期 ≠ 账号失效**。
 *      Microsoft refreshToken 有效期是几个月到一年，
 *      只要它在，accessToken 随时能换 —— 账号等于一直可用。
 *      但渲染层只看 expiresAt，一个陈旧的 expiresAt 就永远显示"已过期"。
 *   而此前**根本没有续期通道**：refreshAccount 只在启动游戏时被调用，
 *   主界面从来没机会把过期令牌换成新的。
 *
 * 用法：node build/verify-account-expiry.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const checks = [];
const P = (n, p, i) => checks.push({ n, p, i });
const section = (t) => console.log(`\n===== ${t} =====`);

(async () => {
  const accSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'core', 'accounts.js'), 'utf8');
  const ipcSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.js'), 'utf8');
  const shellSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'shell.js'), 'utf8');
  const accountsPageSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'pages', 'accounts.js'), 'utf8');
  const storeSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'store.js'), 'utf8');

  /* ---------------- ① 不再写死 12 小时 ---------------- */
  section('① 到期时间用服务端真实值');
  {
    // 生效代码里不该再有写死的 12 小时（注释里提到是可以的）
    const codeOnly = accSrc
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/)/.test(l))
      .join('\n');
    P('★ 生效代码里没有写死的 12 小时', !/12 \* 60 \* 60 \* 1000/.test(codeOnly), '检查非注释行');
    P('★ 读取服务端 expires_in', /const mcExpiresIn = Number\(mc\.expires_in\)/.test(accSrc));
    P('用 expires_in 算 expiresAt', /expiresAt: Date\.now\(\) \+ accessTtlMs/.test(accSrc));
    P('兜底改成 24 小时（不是 12）', /24 \* 60 \* 60 \* 1000/.test(accSrc));
    P('记录了 expiresInSec（便于排查）', /expiresInSec:/.test(accSrc));
    P('★ 新增 canRefresh 标记', /canRefresh: !!newRefresh/.test(accSrc));
  }

  /* ---------------- ② 判定逻辑（对齐 HMCL） ---------------- */
  section('② 界面判定：对齐 HMCL —— 有 refreshToken 就一律显示正常');
  {
    // HMCL 参照：MicrosoftService.validate 只用 now>notAfter 做布尔判断；
    //            MicrosoftAccount.logInWhenCredentialsExpired 是静默刷新，不画徽标。
    P('★ 主界面引入 canRefresh 判定', /const hasRefresh = isMs && acct\.canRefresh !== false && !!acct\.refreshToken/.test(shellSrc));
    P('★ 主界面「失效」只取决于 !hasRefresh', /if \(isMs && !hasRefresh\)/.test(shellSrc));
    P('★ 主界面不再按时间判过期', !/timeUp/.test(shellSrc));
    P('主界面不再有裸的 expired 判定', !/const expired = acct\.expiresAt && acct\.expiresAt < Date\.now\(\);/.test(shellSrc));
    // ★ 只查生效代码，不查注释（注释里提到这句话是在解释「为什么删掉它」）
    const shellCode = shellSrc
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    P('不再显示「下次启动自动续期」这种细节', !/下次启动自动续期/.test(shellCode), '只查非注释行');

    // accounts.js 页面（账号列表）
    P('★ 账号页引入 hasRefresh 判定', /const hasRefresh = isMs && acc\.canRefresh !== false && !!acc\.refreshToken/.test(accountsPageSrc));
    P('★ 账号页「失效」只取决于 !hasRefresh', /const expired = isMs && !hasRefresh/.test(accountsPageSrc));
    P('账号页不再按时间判过期', !/const timeUp = !!\(acc\.expiresAt/.test(accountsPageSrc));
    P('账号页不再有裸的 expired 判定', !/const expired = acc\.expiresAt && acc\.expiresAt < Date\.now\(\);/.test(accountsPageSrc));
  }

  /* ---------------- ③ 续期通道 ---------------- */
  section('③ 续期通道（之前根本没有）');
  {
    P('★ 新增 accounts:refresh 通道', ipcSrc.includes("'accounts:refresh'"));
    P('通道会判离线账号跳过', /离线账号不需要续期/.test(ipcSrc));
    P('通道会判没有 refreshToken', /没有刷新令牌/.test(ipcSrc));
    P('通道返回 canRefresh / hasRefreshToken', /canRefresh: fresh\.canRefresh/.test(ipcSrc) && /hasRefreshToken:/.test(ipcSrc));
    P('★ 正确按数组取账号（list 返回数组）', /const accounts = Array\.isArray\(raw\) \? raw :/.test(ipcSrc));
  }

  /* ---------------- ④ 启动时自动续期 ---------------- */
  section('④ 界面加载时后台自动续期');
  {
    P('★ store 有 refreshStaleMicrosoftAccounts', /async function refreshStaleMicrosoftAccounts/.test(storeSrc));
    P('★ loadAccounts 会触发续期', /refreshStaleMicrosoftAccounts\(\)\.catch/.test(storeSrc));
    P('只挑微软账号', /a\.type === 'microsoft'/.test(storeSrc));
    P('只挑有 refreshToken 的', /a\.refreshToken/.test(storeSrc));
    P('只在快过期/已过期时请求（不浪费网络）', /a\.expiresAt - now < 60 \* 60 \* 1000/.test(storeSrc));
    P('不阻塞界面（不 await）', /refreshStaleMicrosoftAccounts\(\)\.catch\(\(\) => \{\}\)/.test(storeSrc));
    P('续期后重新拉列表并刷新右栏', /updateRightPanel/.test(storeSrc));
    P('★ 按数组处理 accounts:list 结果', /if \(Array\.isArray\(list\)\)/.test(storeSrc));
  }

  /* ---------------- ⑤ 真实数据实测 ---------------- */
  section('⑤ 用真实账号验证（微软 API）');
  {
    const acc = require(path.join(ROOT, 'src', 'main', 'core', 'accounts.js'));
    const os = require('node:os');
    const HOME = path.join(os.homedir(), 'Documents', 'QCL');
    let list = [];
    try {
      list = await acc.list(HOME);
    } catch (e) {
      list = [];
    }
    P('能读到账号列表（数组）', Array.isArray(list), Array.isArray(list) ? `长度 ${list.length}` : typeof list);

    const ms = (Array.isArray(list) ? list : []).find((a) => a && a.type === 'microsoft');
    if (!ms) {
      P('有微软账号可测', false, '本机没有微软账号，跳过真实续期测试');
    } else {
      P('有微软账号可测', true, ms.name);
      P('这个账号有 refreshToken', !!ms.refreshToken);

      const before = ms.expiresAt;
      const beforeExpired = !!(before && before < Date.now());
      console.log(`   续期前 expiresAt=${before ? new Date(before).toLocaleString('zh-CN') : '无'}（已过期=${beforeExpired}）`);

      let fresh = null;
      let err = null;
      try {
        fresh = await acc.refreshAccount(ms, HOME);
      } catch (e) {
        err = e;
      }

      if (err) {
        P('★ 真实续期成功', false, `网络/凭据问题：${err.message.slice(0, 80)}`);
      } else {
        /**
         * ★ 注意：refreshAccount 有「资料齐全且未临近过期就直接返回原记录」的短路，
         *   所以连跑两次时第二次不会真的换令牌（这是**正确**的省网络行为）。
         *   因此这里不把「令牌字符串变了」作为唯一成功判据，
         *   而看更本质的两件事：
         *     · 拿回来的 expiresAt 在未来（能正常用）
         *     · expiresInSec 是服务端真实值
         */
        const tokenChanged = !!fresh && fresh.accessToken !== ms.accessToken;
        const stillValid = !!(fresh && fresh.expiresAt && fresh.expiresAt > Date.now());
        P('★ 续期后账号可用（expiresAt 在未来）', stillValid,
          fresh && fresh.expiresAt ? new Date(fresh.expiresAt).toLocaleString('zh-CN') : '无');
        P('★ expiresInSec 是服务端真实值（86400=24h）', fresh && fresh.expiresInSec === 86400, fresh && fresh.expiresInSec);
        P('canRefresh 为 true', fresh && fresh.canRefresh === true);
        console.log(`   （本次是否换了新令牌=${tokenChanged}；未换是因为原记录仍然有效，属于正常的省网络短路）`);

        // 修后判定：有 refreshToken 就一律不显示失效
        const isMs = fresh && fresh.type === 'microsoft';
        const hasRefresh = isMs && fresh.canRefresh !== false && !!fresh.refreshToken;
        P('★ 修后判定不会显示「失效」', !(isMs && !hasRefresh), { hasRefresh });

        const oldLogicWouldSayExpired = beforeExpired;
        console.log(`   （旧逻辑在续期前会误报「已过期」=${oldLogicWouldSayExpired}，这就是用户看到的现象）`);
      }
    }
  }

  /* ---------------- 汇总 ---------------- */
  console.log('\n================ 验收结果 ================');
  let fail = 0;
  for (const c of checks) {
    if (!c.p) fail += 1;
    console.log(`${c.p ? 'PASS' : 'FAIL'}  ${c.n}${c.i !== undefined && c.i !== '' ? '  → ' + JSON.stringify(c.i) : ''}`);
  }
  console.log('--------------------------------------------------');
  console.log(`合计 ${checks.length} 项，失败 ${fail} 项`);
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((e) => {
  console.log('\nFATAL ' + ((e && e.stack) || e));
  process.exitCode = 1;
});
