import os from 'node:os'
import path from 'node:path'
import { readdir, access } from 'node:fs/promises'
import { exec as execCallback, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execCallback)

async function pathExists(target: string) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function checkNvcc() {
  try {
    await exec('nvcc --version', { env: process.env })
  } catch {
    throw new Error('nvcc not found')
  }
}

function sortVersionsDesc(versions: string[]) {
  return versions.sort((a, b) => {
    const verA = parseInt(a.replace('v', '').replace('.', ''))
    const verB = parseInt(b.replace('v', '').replace('.', ''))
    return verB - verA
  })
}

async function setupCuda() {
  const cudaPath = process.env.CUDA_PATH
  if (cudaPath) {
    const binPath = path.join(cudaPath, 'bin')
    process.env.PATH = `${binPath}${path.delimiter}${process.env.PATH}`
    return
  }

  const cudaRoot = 'C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA'
  const versions = await readdir(cudaRoot).catch(() => [])

  sortVersionsDesc(versions)

  for (const version of versions) {
    if (version.startsWith('v')) {
      const binPath = path.join(cudaRoot, version, 'bin')
      if (await pathExists(binPath)) {
        process.env.PATH = `${binPath}${path.delimiter}${process.env.PATH}`
        process.env.CUDA_PATH = path.join(cudaRoot, version)

        console.log(`Added CUDA to PATH: ${binPath}`)
        return
      }
    }
  }

  throw new Error(
    'NVCC not found. Please install the CUDA Toolkit from https://developer.nvidia.com/cuda-downloads',
  )
}

async function setupCudnn() {
  const cudnnRoot = 'C:/Program Files/NVIDIA/CUDNN'
  const versions = await readdir(cudnnRoot).catch(() => [])

  sortVersionsDesc(versions)

  for (const version of versions) {
    if (version.startsWith('v')) {
      const binPath = path.join(cudnnRoot, version, 'bin')

      if (await pathExists(binPath)) {
        const versions = await readdir(binPath)

        sortVersionsDesc(versions)

        for (const version of versions) {
          const fullPath = path.join(binPath, version, 'x64')
          process.env.PATH = `${fullPath}${path.delimiter}${process.env.PATH}`

          console.log(`Added cuDNN to PATH: ${fullPath}`)
          return
        }
      }
    }

    throw new Error(
      'cuDNN not found. Please install cuDNN from https://developer.nvidia.com/rdp/cudnn-download',
    )
  }
}

async function setupCl() {
  const vsRoot = 'C:/Program Files/Microsoft Visual Studio'
  const vsVersions = await readdir(vsRoot).catch(() => [])

  for (const vsVersion of vsVersions) {
    const vcPath = path.join(vsRoot, vsVersion, 'Community/VC/Tools/MSVC')
    if (await pathExists(vcPath)) {
      const msvcVersions = await readdir(vcPath)
      for (const msvcVersion of msvcVersions) {
        const binPath = path.join(vcPath, msvcVersion, 'bin/Hostx64/x64')
        if (await pathExists(binPath)) {
          process.env.PATH = `${binPath}${path.delimiter}${process.env.PATH}`

          console.log(`Added cl.exe to PATH: ${binPath}`)
          return
        }
      }
    }
  }

  throw new Error(
    'cl.exe not found. Please install Visual Studio with C++ build tools from https://visualstudio.microsoft.com/downloads/',
  )
}

/**
 * Auto-detect the installed NVIDIA GPU's compute capability via
 * `nvidia-smi` and set `CUDA_COMPUTE_CAP` so candle's CUDA kernels are
 * compiled for the *right* SM target instead of whatever the build
 * scripts default to.
 *
 * Without this:
 *   - PTX forward-compat means kernels from an older SM still run on
 *     a newer GPU (via runtime JIT by the driver), but slower than
 *     native cubin.
 *   - cubin-only kernels (some cuBLAS / cuDNN paths) just don't run
 *     at all on architectures they weren't compiled for — which is
 *     how someone on an RTX 50xx (Blackwell, SM 12.0) ends up with a
 *     binary built for Turing (SM 7.5) silently failing.
 *
 * Respects an existing CUDA_COMPUTE_CAP env var if set (lets CI /
 * power users pin a multi-target string like "75;86;89;120").
 */
async function setupComputeCap() {
  if (process.env.CUDA_COMPUTE_CAP) return
  try {
    const { stdout } = await exec(
      'nvidia-smi --query-gpu=compute_cap --format=csv,noheader',
      { env: process.env },
    )
    const cap = stdout.split('\n')[0]?.trim()
    if (cap && /^\d+\.\d+$/.test(cap)) {
      // bindgen_cuda's build script parses CUDA_COMPUTE_CAP as a bare
      // integer (no dot) — "75", "86", "120". nvidia-smi reports the
      // human-friendly dotted form ("7.5", "8.6", "12.0"). Strip the
      // dot before exporting, otherwise the build panics with
      // ParseIntError.
      const intCap = cap.replace('.', '')
      process.env.CUDA_COMPUTE_CAP = intCap
      console.log(
        `Detected GPU compute capability: ${cap} → CUDA_COMPUTE_CAP=${intCap}`,
      )
    }
  } catch {
    // nvidia-smi missing or failed — let candle's build script fall
    // back to its own default. Not fatal because the CPU code path
    // still works.
  }
}

/**
 * Strip the local home directory + workspace root out of the source
 * paths that Rust bakes into the binary for panic backtraces. Without
 * this, a release build contains hundreds of paths like
 * `C:\Users\<your-username>\.cargo\registry\src\...`, leaking your OS
 * username to anyone who downloads the binary.
 *
 * Paths are computed at build time (not committed) so different
 * contributors don't have to share filesystem layouts.
 */
function setupRemapPathPrefix() {
  const home = os.homedir()
  // Workspace root is two levels up from scripts/dev.ts
  const workspace = path.resolve(__dirname, '..')
  const flags = [
    `--remap-path-prefix=${path.join(home, '.cargo')}=/cargo`,
    `--remap-path-prefix=${home}=/home`,
    `--remap-path-prefix=${workspace}=/koharu`,
  ]
  const existing = process.env.RUSTFLAGS ?? ''
  process.env.RUSTFLAGS = existing
    ? `${existing} ${flags.join(' ')}`
    : flags.join(' ')
}

async function dev() {
  setupRemapPathPrefix()

  // Tracks whether the CUDA toolchain (nvcc + cuDNN + cl) was wired up
  // successfully. Drives the `--features cuda` injection below — without
  // that flag, `cfg!(feature = "cuda")` is false at compile time and
  // `cuda_is_available()` short-circuits to CPU even on machines with
  // a working RTX driver. See koharu-ml/src/lib.rs:146.
  let cudaReady = false

  if (os.type() === 'Windows_NT') {
    try {
      // First, try to check if nvcc is available
      await checkNvcc()
        // If not found, try to set up CUDA paths
        .catch(async () => {
          await setupCuda()
          // Check again after setup
          await checkNvcc()
        })

      // Setup cuDNN path
      await setupCudnn()

      // Setup cl.exe path
      await setupCl()

      // Detect this machine's GPU compute capability for native kernel
      // compilation. Must come after CUDA setup so nvidia-smi is on PATH.
      await setupComputeCap()

      cudaReady = true
    } catch (err) {
      // Any step of the CUDA toolchain setup failed — log and continue
      // with a CPU build so dev workflow doesn't hard-block on missing
      // CUDA when the developer just wants a quick CPU iteration.
      const reason = err instanceof Error ? err.message : String(err)
      console.warn(`[koharu] CUDA toolchain unavailable: ${reason}`)
      console.warn(
        '[koharu] Building without `--features cuda`. ML inference will run on CPU.',
      )
    }
  }

  const args = process.argv.slice(2)
  if (args.length === 0) {
    throw new Error('No command provided')
  }

  // Inject `--features cuda` right after `tauri dev` / `tauri build`
  // when the CUDA toolchain is ready. tauri-cli forwards `--features`
  // through to cargo. Position matters: it must land before the
  // first `--` separator (which delimits cargo args from app args).
  if (
    cudaReady &&
    args[0] === 'tauri' &&
    (args[1] === 'dev' || args[1] === 'build')
  ) {
    // Don't double-inject if the caller already passed --features.
    const hasFeaturesFlag = args.some(
      (a) => a === '--features' || a === '-f' || a.startsWith('--features='),
    )
    if (!hasFeaturesFlag) {
      const sepIdx = args.indexOf('--')
      const insertAt = sepIdx === -1 ? args.length : sepIdx
      args.splice(insertAt, 0, '--features', 'cuda')
      console.log('[koharu] Injected `--features cuda` for accelerated build.')
    }
  }

  const proc = spawn(args.join(' '), {
    stdio: 'inherit',
    shell: true,
    env: process.env,
  })

  proc.on('error', (err) => {
    throw err
  })

  proc.on('exit', (code) => {
    process.exit(code)
  })
}

dev().catch((err) => {
  process.stderr.write(`Error: ${err.message} \n`)
  process.exit(1)
})
