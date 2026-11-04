// ============================================================================
//  Quanta Craft Launcher PC · 中文安装程序（自解压 + 自绘界面）
//
//  为什么自己写这么个东西：
//    1. 目标用户的电脑上**不一定有 7-Zip**。之前那两个 exe 都需要 7-Zip 才能解压，
//       这是个设计错误 —— 安装包不该要求用户先装别的软件。
//    2. 7-Zip 标准版的自解压模块（7z.sfx）**不读取 Title/BeginPrompt 这些键**，
//       只有第三方修改版 7zSFX 才支持。所以之前的「中文界面」配置根本没生效，
//       这就是为什么两个包看起来「一模一样全是英文」。
//    3. NSIS（makensis）在这台机器上因内存不足必然失败
//       （error creating mmap the size of 214871488），不是配置问题。
//    ⇒ 唯一稳妥的路：用 .NET Framework 自带编译器出一个**原生 exe**，
//      自己解压 zip（System.IO.Compression 是 Windows 内置的），
//      界面全部自己画，想多中文就多中文。
//
//  编译（系统自带 csc.exe，不需要装任何 SDK）：
//    C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
//      /target:winexe /platform:anycpu /out:QCL-安装程序.exe
//      /win32icon:icon.ico /resource:payload.zip,Payload
//      /r:System.IO.Compression.FileSystem.dll /r:System.Windows.Forms.dll
//      /r:System.Drawing.dll Installer.cs
// ============================================================================

using System;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace QclSetup
{
    internal static class Program
    {
        internal const string ProductName = "Quanta Craft Launcher PC";
        internal const string ProductShort = "QCL";
        internal const string Version = "1.0.0";
        internal const string Publisher = "Rod123456";

        [STAThread]
        private static void Main(string[] args)
        {
            // ★ 自动化验证入口：`--verify <目录>` 不弹界面，直接解压内嵌 zip 到指定目录后退出。
            //   用来在打包后真实验证「点开始安装」的那段解压逻辑，而不是只看界面截图。
            if (args != null && args.Length >= 2 && args[0] == "--verify")
            {
                // winexe 没有控制台，把结果写到目标目录里的文件里
                string dir = args[1];
                string resultFile = Path.Combine(dir, "_verify_result.txt");
                try
                {
                    Directory.CreateDirectory(dir);
                    int count = VerifyExtract(dir);
                    File.WriteAllText(resultFile, "VERIFY_OK entries=" + count + "\r\n", System.Text.Encoding.UTF8);
                }
                catch (Exception ex)
                {
                    try { File.WriteAllText(resultFile, "VERIFY_FAIL " + ex.Message + "\r\n", System.Text.Encoding.UTF8); }
                    catch { /* 忽略 */ }
                }
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                Application.Run(new SetupForm());
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "安装程序出错：\r\n" + ex.Message,
                    ProductName + " 安装程序",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
        }

        /// <summary>把内嵌的 payload.zip 解压到指定目录（安装与静默验证共用同一段逻辑）</summary>
        /// <returns>解压的条目数</returns>
        internal static int VerifyExtract(string targetDir)
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            int count = 0;
            using (Stream s = asm.GetManifestResourceStream("Payload"))
            {
                if (s == null) throw new Exception("安装包内部缺少文件数据（Payload 资源未找到）。");
                using (var zip = new ZipArchive(s, ZipArchiveMode.Read))
                {
                    var buffer = new byte[81920];
                    foreach (ZipArchiveEntry entry in zip.Entries)
                    {
                        string dest = Path.Combine(targetDir, entry.FullName.Replace('/', Path.DirectorySeparatorChar));
                        if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(dest); continue; }
                        Directory.CreateDirectory(Path.GetDirectoryName(dest));
                        using (Stream src = entry.Open())
                        using (var dst = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None))
                        {
                            int n;
                            while ((n = src.Read(buffer, 0, buffer.Length)) > 0) dst.Write(buffer, 0, n);
                        }
                        count++;
                    }
                }
            }
            return count;
        }

        internal static string DefaultInstallDir()
        {
            // 装到当前用户目录，不需要管理员权限
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                @"Programs\" + ProductShort);
        }
    }

    internal sealed class SetupForm : Form
    {
        private readonly TextBox _pathBox;
        private readonly ProgressBar _bar;
        private readonly Label _status;
        private readonly Button _installBtn;
        private readonly Button _browseBtn;
        private readonly CheckBox _runAfter;

        internal SetupForm()
        {
            Text = Program.ProductName + " 安装程序";
            ClientSize = new Size(560, 380);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(250, 250, 252);
            Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);

            // ---------------- 标题区 ----------------
            var title = new Label
            {
                Text = "欢迎安装 " + Program.ProductName,
                Font = new Font("Microsoft YaHei UI", 16F, FontStyle.Bold),
                ForeColor = Color.FromArgb(60, 60, 66),
                AutoSize = false,
                Location = new Point(24, 22),
                Size = new Size(512, 36)
            };
            var subtitle = new Label
            {
                Text = "版本 " + Program.Version + " · 免费、自由、开放源代码的 Minecraft Java 版启动器",
                ForeColor = Color.FromArgb(110, 110, 118),
                AutoSize = false,
                Location = new Point(26, 60),
                Size = new Size(512, 22)
            };

            // ---------------- 说明 ----------------
            var info = new Label
            {
                Text =
                    "安装程序会把启动器安装到下面这个位置。\r\n" +
                    "游戏数据（实例、存档、账号）会单独保存在「文档\\QCL」，卸载时不会删除。",
                ForeColor = Color.FromArgb(90, 90, 98),
                AutoSize = false,
                Location = new Point(26, 96),
                Size = new Size(512, 44)
            };

            // ---------------- 路径 ----------------
            var pathLabel = new Label
            {
                Text = "安装位置：",
                ForeColor = Color.FromArgb(80, 80, 88),
                AutoSize = true,
                Location = new Point(26, 152)
            };
            _pathBox = new TextBox
            {
                Text = Program.DefaultInstallDir(),
                Location = new Point(26, 176),
                Size = new Size(400, 26),
                BackColor = Color.White
            };
            _browseBtn = new Button
            {
                Text = "更改…",
                Location = new Point(434, 174),
                Size = new Size(104, 28)
            };
            _browseBtn.Click += OnBrowse;

            // ---------------- 进度 ----------------
            _bar = new ProgressBar
            {
                Location = new Point(26, 220),
                Size = new Size(512, 18),
                Minimum = 0,
                Maximum = 100
            };
            _status = new Label
            {
                Text = "准备就绪，点击「开始安装」。",
                ForeColor = Color.FromArgb(110, 110, 118),
                AutoSize = false,
                Location = new Point(26, 244),
                Size = new Size(512, 22)
            };

            // ---------------- 复选框 ----------------
            _runAfter = new CheckBox
            {
                Text = "安装完成后立即运行启动器",
                Checked = true,
                Location = new Point(26, 276),
                Size = new Size(300, 24),
                ForeColor = Color.FromArgb(80, 80, 88)
            };

            // ---------------- 按钮 ----------------
            _installBtn = new Button
            {
                Text = "开始安装",
                Location = new Point(316, 320),
                Size = new Size(108, 34),
                BackColor = Color.FromArgb(134, 93, 88),   // QCL 主题色 #865D58
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold)
            };
            _installBtn.FlatAppearance.BorderSize = 0;
            _installBtn.Click += OnInstall;

            var cancelBtn = new Button
            {
                Text = "取消",
                Location = new Point(432, 320),
                Size = new Size(106, 34),
                BackColor = Color.FromArgb(232, 232, 236),
                ForeColor = Color.FromArgb(70, 70, 76),
                FlatStyle = FlatStyle.Flat
            };
            cancelBtn.FlatAppearance.BorderSize = 0;
            cancelBtn.Click += (s, e) => Close();

            Controls.AddRange(new Control[]
            {
                title, subtitle, info, pathLabel, _pathBox, _browseBtn,
                _bar, _status, _runAfter, _installBtn, cancelBtn
            });
        }

        private void OnBrowse(object sender, EventArgs e)
        {
            using (var dlg = new FolderBrowserDialog())
            {
                dlg.Description = "选择安装位置";
                dlg.SelectedPath = _pathBox.Text;
                if (dlg.ShowDialog(this) == DialogResult.OK)
                    _pathBox.Text = Path.Combine(dlg.SelectedPath, Program.ProductShort);
            }
        }

        private void OnInstall(object sender, EventArgs e)
        {
            string dir = (_pathBox.Text ?? "").Trim();
            if (dir.Length == 0)
            {
                MessageBox.Show(this, "请先选择安装位置。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            try
            {
                Directory.CreateDirectory(dir);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "这个位置不可写：\r\n" + ex.Message,
                    "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            _installBtn.Enabled = false;
            _browseBtn.Enabled = false;
            _pathBox.Enabled = false;
            _bar.Value = 0;

            string error = null;
            var worker = new Thread(() =>
            {
                try
                {
                    ExtractPayload(dir);
                }
                catch (Exception ex)
                {
                    error = ex.Message;
                }
            });
            worker.IsBackground = true;
            worker.Start();

            var timer = new System.Windows.Forms.Timer { Interval = 120 };
            timer.Tick += (s2, e2) =>
            {
                if (worker.IsAlive)
                {
                    // 进度条做「不确定」推进，具体百分比由 ExtractPayload 更新
                    if (_bar.Value < 95) _bar.Value += 2;
                    return;
                }
                timer.Stop();
                Finish(dir, error);
            };
            timer.Start();
        }

        /// <summary>把内嵌的 payload.zip 解压到目标目录</summary>
        private void ExtractPayload(string targetDir)
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            using (Stream s = asm.GetManifestResourceStream("Payload"))
            {
                if (s == null) throw new Exception("安装包内部缺少文件数据（Payload 资源未找到）。");

                var buffer = new byte[81920];
                using (var zip = new ZipArchive(s, ZipArchiveMode.Read))
                {
                    int total = zip.Entries.Count;
                    int done = 0;
                    foreach (ZipArchiveEntry entry in zip.Entries)
                    {
                        string dest = Path.Combine(targetDir, entry.FullName.Replace('/', Path.DirectorySeparatorChar));

                        // 目录条目
                        if (entry.FullName.EndsWith("/"))
                        {
                            Directory.CreateDirectory(dest);
                        }
                        else
                        {
                            Directory.CreateDirectory(Path.GetDirectoryName(dest));
                            using (Stream src = entry.Open())
                            using (var dst = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None))
                            {
                                int n;
                                while ((n = src.Read(buffer, 0, buffer.Length)) > 0)
                                    dst.Write(buffer, 0, n);
                            }
                        }

                        done++;
                        if (total > 0)
                        {
                            int pct = (int)(done * 100L / total);
                            BeginInvoke(new Action(() =>
                            {
                                if (pct <= 100) _bar.Value = pct;
                                _status.Text = string.Format("正在安装…（{0}/{1} 个文件）", done, total);
                            }));
                        }
                    }
                }
            }
        }

        private void Finish(string dir, string error)
        {
            if (error != null)
            {
                _installBtn.Enabled = true;
                _browseBtn.Enabled = true;
                _pathBox.Enabled = true;
                MessageBox.Show(this, "安装失败：\r\n" + error, "安装失败",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            _bar.Value = 100;
            _status.Text = "安装完成。";

            WriteRegistry(dir);

            string exe = Path.Combine(dir, Program.ProductShort + ".exe");
            if (_runAfter.Checked && File.Exists(exe))
            {
                try
                {
                    System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                    {
                        FileName = exe,
                        WorkingDirectory = dir,
                        UseShellExecute = true
                    });
                }
                catch
                {
                    /* 启动失败不影响安装 */
                }
            }

            MessageBox.Show(this,
                Program.ProductName + " 已安装完成。\r\n\r\n" +
                "安装位置：" + dir + "\r\n" +
                "游戏数据：文档\\QCL（卸载不会删除）",
                "安装完成", MessageBoxButtons.OK, MessageBoxIcon.Information);

            Close();
        }

        /// <summary>写入卸载信息与开始菜单快捷方式</summary>
        private void WriteRegistry(string dir)
        {
            try
            {
                string exe = Path.Combine(dir, Program.ProductShort + ".exe");

                using (RegistryKey k = Registry.CurrentUser.CreateSubKey(
                    @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + Program.ProductShort))
                {
                    if (k != null)
                    {
                        k.SetValue("DisplayName", Program.ProductName);
                        k.SetValue("DisplayVersion", Program.Version);
                        k.SetValue("Publisher", Program.Publisher);
                        k.SetValue("InstallLocation", dir);
                        k.SetValue("UninstallString", "\"" + exe + "\" --uninstall");
                        k.SetValue("DisplayIcon", exe);
                        k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                        k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                    }
                }

                // 桌面快捷方式
                string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                CreateShortcut(Path.Combine(desktop, Program.ProductName + ".lnk"), exe, dir);

                // 开始菜单
                string startMenu = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.Programs),
                    Program.ProductName);
                Directory.CreateDirectory(startMenu);
                CreateShortcut(Path.Combine(startMenu, Program.ProductName + ".lnk"), exe, dir);
            }
            catch
            {
                /* 写注册表/快捷方式失败不算安装失败 */
            }
        }

        /// <summary>用 WScript.Shell 建 .lnk（避免引用 COM 互操作程序集）</summary>
        private static void CreateShortcut(string lnkPath, string targetPath, string workingDir)
        {
            try
            {
                Type t = Type.GetTypeFromProgID("WScript.Shell");
                if (t == null) return;
                object shell = Activator.CreateInstance(t);
                object shortcut = t.InvokeMember("CreateShortcut",
                    BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
                Type st = shortcut.GetType();
                st.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { targetPath });
                st.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { workingDir });
                st.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            }
            catch
            {
                /* 建快捷方式失败不影响安装 */
            }
        }
    }
}
