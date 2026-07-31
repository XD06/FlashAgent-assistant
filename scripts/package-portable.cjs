"use strict";
const path = require("path");
const fs = require("fs");

// 1. 确保没有残留进程锁定文件
const { execSync } = require("child_process");
try { execSync('taskkill /F /IM electron.exe', { stdio: 'ignore' }); } catch {}
try { execSync('taskkill /F /IM "FlashAgent-assistant.exe"', { stdio: 'ignore' }); } catch {}

const root = path.resolve(__dirname, "..");
// 每次用新目录名，彻底避免文件锁定问题
const outDir = path.join(root, "dist-build-" + Date.now());

// 3. 读取 electron 版本
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const electronVersion = (pkg.devDependencies && pkg.devDependencies.electron) || "33.2.1";
console.log("Electron version:", electronVersion);

// 4. 调用 electron-packager
const packager = require("electron-packager");

(async () => {
  console.log("Starting packaging...");
  const appPaths = await packager({
    dir: root,
    name: "FlashAgent-assistant",
    platform: "win32",
    arch: "x64",
    out: outDir,
    overwrite: false,
    icon: path.join(root, "build", "icon.ico"),
    asar: true,
    asarUnpack: ["node_modules/selection-hook/**"],
    electronVersion: electronVersion.replace(/[^0-9.]/g, ""),
    // 排除不需要的文件/目录，大幅减小体积
    ignore: [
      // 源代码
      /^\/src\/.*/,
      // 构建脚本
      /^\/scripts\/.*/,
      // 文档
      /^\/docs\/.*/,
      /^\/CHANGELOG\.md$/,
      /^\/CODE_OF_CONDUCT\.md$/,
      /^\/CONTRIBUTING\.md$/,
      /^\/README\.md$/,
      /^\/LICENSE$/,
      // Git
      /^\/\.git.*/,
      /^\/\.github\/.*/,
      // 构建输出
      /^\/dist\/.*/,
      /^\/dist-app\/.*/,
      /^\/dist-portable\/.*/,
      /^\/dist-portable-old-.*/,
      /^\/dist-build-.*/,
      // 配置文件
      /^\/\.vscode\/.*/,
      /^\/\.idea\/.*/,
      /^\/tsconfig\.json$/,
      /^\/electron\.vite\.config\.ts$/,
      /^\/eslint\.config\..*$/,
      /^\/\.eslintrc.*/,
      /^\/\.prettierrc.*/,
      // 开发依赖 - 只保留运行时需要的
      /node_modules\/\.cache\/.*/,
      /node_modules\/.*\.test\..*/,
      /node_modules\/.*\.md$/,
      /node_modules\/.*\.markdown$/,
      /node_modules\/.*\.ts$/,
      /node_modules\/.*\.map$/,
      /node_modules\/.*\.tsbuildinfo$/,
      // 类型定义包（运行时不需要）
      /node_modules\/@types\/.*/,
      // 渲染层依赖已被 vite 打进 out/renderer，运行时只需要
      // MCP SDK / electron-store / undici / selection-hook 这几个主进程外链包
      /node_modules\/react\/.*/,
      /node_modules\/react-dom\/.*/,
      /node_modules\/scheduler\/.*/,
      /node_modules\/marked\/.*/,
      /node_modules\/@electron-toolkit\/.*/,
      // 开发工具
      /node_modules\/typescript\/.*/,
      /node_modules\/electron\/.*/,
      /node_modules\/electron-vite\/.*/,
      /node_modules\/electron-builder\/.*/,
      /node_modules\/electron-packager\/.*/,
      /node_modules\/vite\/.*/,
      /node_modules\/rollup\/.*/,
      /node_modules\/esbuild\/.*/,
      /node_modules\/eslint\/.*/,
      /node_modules\/prettier\/.*/,
      /node_modules\/@eslint\/.*/,
      /node_modules\/@rollup\/.*/,
      /node_modules\/@vitejs\/.*/,
      /node_modules\/app-builder-bin\/.*/,
      /node_modules\/7zip-bin\/.*/,
      /node_modules\/@babel\/.*/,
      /node_modules\/\.vite\/.*/,
      /node_modules\/vitest\/.*/,
      /node_modules\/dompurify\/.*/,
      // mac/linux 的原生模块 prebuilds
      /node_modules\/selection-hook\/prebuilds\/darwin-.*/,
      /node_modules\/selection-hook\/prebuilds\/linux-.*/,
      /node_modules\/selection-hook\/prebuilds\/win32-arm64\/.*/,
      // selection-hook 的源码和构建文件
      /node_modules\/selection-hook\/src\/.*/,
      /node_modules\/selection-hook\/examples\/.*/,
      /node_modules\/selection-hook\/docs\/.*/,
      /node_modules\/selection-hook\/binding\.gyp$/,
      /node_modules\/selection-hook\/\.clang-format-ignore$/,
      // pnpm 相关
      /^\/pnpm-lock\.yaml$/,
      /^\/pnpm-workspace\.yaml$/,
      // 其余项目杂项文件
      /^\/README\.en\.md$/,
      /^\/SECURITY\.md$/,
      /^\/tsconfig.*\.json$/,
      /^\/tsconfig.*\.tsbuildinfo$/,
      /^\/package-lock\.json$/,
      /^\/electron-builder\.yml$/,
      /^\/vitest\.config\.ts$/,
    ],
    win32metadata: {
      ProductName: "FlashAgent-assistant",
      CompanyName: "XD06",
      FileDescription: "FlashAgent-assistant",
      OriginalFilename: "FlashAgent-assistant.exe",
    },
    afterCopy: [async (buildPath, _electronVersion, _platform, _arch, callback) => {
      console.log("Running afterCopy hook...");
      // 在拷贝完成后立即清理不需要的文件
      // 1. 删除多余语言包（只保留 zh-CN 和 en-US）
      const localesDir = path.join(buildPath, "..", "locales");
      // afterCopy 在 app 目录上运行，locales 在上一级
      // 这里通过 afterComplete 来处理更好
      callback();
    }],
  });
  console.log("Packaged to:", appPaths);

  // 后处理：删除不需要的文件来减小体积
  const appDir = appPaths[0];
  console.log("Post-processing to reduce size...");

  // 1. 只保留中文和英文语言包
  const localesDir = path.join(appDir, "locales");
  if (fs.existsSync(localesDir)) {
    const keep = ["zh-CN.pak", "en-US.pak", "en-GB.pak"];
    let saved = 0;
    for (const f of fs.readdirSync(localesDir)) {
      if (!keep.includes(f)) {
        const fp = path.join(localesDir, f);
        saved += fs.statSync(fp).size;
        fs.unlinkSync(fp);
      }
    }
    console.log(`  Locales: removed ${fs.readdirSync(localesDir).length === keep.length ? 'OK' : 'partial'}, saved ${(saved / 1024 / 1024).toFixed(1)} MB`);
  }

  // 2. 删除 LICENSES.chromium.html（8.7 MB，运行时不需要）
  const licensesFile = path.join(appDir, "LICENSES.chromium.html");
  if (fs.existsSync(licensesFile)) {
    fs.unlinkSync(licensesFile);
    console.log("  Removed LICENSES.chromium.html");
  }

  // 3. 删除 LICENSE 文件
  const licenseFile = path.join(appDir, "LICENSE");
  if (fs.existsSync(licenseFile)) {
    fs.unlinkSync(licenseFile);
    console.log("  Removed LICENSE");
  }

  // 计算最终大小
  const finalSize = require("child_process").execSync(`powershell -Command "(Get-ChildItem '${appDir}' -Recurse | Measure-Object -Property Length -Sum).Sum"`).toString().trim();
  console.log(`Final size: ${(parseInt(finalSize) / 1024 / 1024).toFixed(1)} MB`);
  console.log("Done!");
})().catch(err => {
  console.error("Packaging failed:", err);
  process.exit(1);
});
