import { execFile } from 'node:child_process';
import { console } from 'node:inspector';
import { extname, join, relative } from 'node:path';
export const buildFile = (viteConfig, config, id) => {
    const workDir = config.workDir;
    const outputPath = join(config.goBuildDir, relative(process.cwd(), id.replace(extname(id), "") + ".wasm"));
    //const result = execFile(config.goBinaryPath, ["build", ...config.goBuildExtraArgs || [], "-o", outputPath, id], {
    viteConfig.logger.error(`\nbuild: ${config.goBinaryPath} build -o ${outputPath}`);
    const result = execFile(config.goBinaryPath, ["build", "-o", outputPath], {
        cwd: workDir,
        env: {
            GOPATH: process.env.GOPATH,
            GOROOT: process.env.GOROOT,
            GOMODCACHE: process.env.GOMODCACHE,
            GOCACHE: process.env.GOCACHE,
            GOOS: "js",
            GOARCH: "wasm"
        }
    }, (err, stdout, stderr) => {
        if (err != null) {
            throw err;
        }
        if (stdout != "") {
            viteConfig.logger.info(stdout);
        }
        if (stderr != "") {
            viteConfig.logger.error(stderr);
        }
    });
    return new Promise((resolve, reject) => {
        result.once("exit", (code, _) => {
            if (code !== 0) {
                return reject(new Error(`builder exit with code: ${code}`));
            }
            resolve(outputPath);
        });
        result.once("error", (err) => {
            reject(err);
        });
    });
};
