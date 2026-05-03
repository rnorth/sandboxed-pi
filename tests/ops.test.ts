/**
 * Tests for ops.ts — Docker-based operations factories.
 *
 * Depends on execInContainer from docker.ts, which we mock.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock execInContainer from docker.ts
const mockExecInContainer = vi.fn();
vi.mock("../src/docker.js", () => ({
  execInContainer: (...args: unknown[]) => mockExecInContainer(...args),
}));

const {
  createDockerReadOps,
  createDockerWriteOps,
  createDockerEditOps,
  createDockerBashOps,
  createDockerLsOps,
  createDockerGrepOps,
  createDockerFindOps,
} = await import("../src/ops.js");

const CONTAINER = "test-container";

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// ReadOperations
// ---------------------------------------------------------------------------

describe("createDockerReadOps", () => {
  it("readFile calls execInContainer with cat and returns Buffer", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from("file contents\n"),
      stderr: Buffer.from(""),
    });

    const ops = createDockerReadOps(CONTAINER);
    const result = await ops.readFile("/path/to/file.txt");

    expect(mockExecInContainer).toHaveBeenCalledWith(CONTAINER, ["cat", "/path/to/file.txt"]);
    expect(result).toBeInstanceOf(Buffer);
    expect(result.toString()).toBe("file contents\n");
  });

  it("readFile throws on non-zero exit", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from("cat: No such file"),
    });

    const ops = createDockerReadOps(CONTAINER);
    await expect(ops.readFile("/nonexistent")).rejects.toThrow("read failed: cat: No such file");
  });

  it("access calls execInContainer with test -r", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    });

    const ops = createDockerReadOps(CONTAINER);
    await ops.access("/path/to/file.txt");

    expect(mockExecInContainer).toHaveBeenCalledWith(CONTAINER, ["test", "-r", "/path/to/file.txt"]);
  });

  it("access throws on non-zero exit", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    });

    const ops = createDockerReadOps(CONTAINER);
    await expect(ops.access("/restricted")).rejects.toThrow("File not readable");
  });

  it("detectImageMimeType returns mime for known image formats", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from("image/png\n"),
      stderr: Buffer.from(""),
    });

    const ops = createDockerReadOps(CONTAINER);
    const mime = await ops.detectImageMimeType!("/path/img.png");

    expect(mockExecInContainer).toHaveBeenCalledWith(CONTAINER, [
      "file", "--mime-type", "-b", "/path/img.png",
    ]);
    expect(mime).toBe("image/png");
  });

  it("detectImageMimeType returns null for non-image files", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from("text/plain\n"),
      stderr: Buffer.from(""),
    });

    const ops = createDockerReadOps(CONTAINER);
    const mime = await ops.detectImageMimeType!("/path/file.txt");
    expect(mime).toBeNull();
  });

  it("detectImageMimeType returns null on failure", async () => {
    mockExecInContainer.mockRejectedValue(new Error("docker error"));

    const ops = createDockerReadOps(CONTAINER);
    const mime = await ops.detectImageMimeType!("/path/img.png");
    expect(mime).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WriteOperations
// ---------------------------------------------------------------------------

describe("createDockerWriteOps", () => {
  it("writeFile calls execInContainer with stdin content and mkdir -p + cat >", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    });

    const ops = createDockerWriteOps(CONTAINER);
    await ops.writeFile("/tmp/test.txt", "hello world");

    // The command should make the directory and write via cat
    const [containerArg, cmdArgs, options] = mockExecInContainer.mock.calls[0];
    expect(containerArg).toBe(CONTAINER);
    expect(cmdArgs[0]).toBe("bash");
    expect(cmdArgs[1]).toBe("-c");
    expect(cmdArgs[2]).toContain("mkdir -p \"$(dirname");
    expect(cmdArgs[2]).toContain("/tmp/test.txt");
    expect(cmdArgs[2]).toContain("cat >");
    expect(options.stdin).toBe("hello world");
  });

  it("writeFile throws on non-zero exit", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from("Disk full"),
    });

    const ops = createDockerWriteOps(CONTAINER);
    await expect(ops.writeFile("/tmp/f.txt", "data")).rejects.toThrow("write failed: Disk full");
  });

  it("mkdir calls execInContainer with mkdir -p", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    });

    const ops = createDockerWriteOps(CONTAINER);
    await ops.mkdir("/tmp/newdir");

    expect(mockExecInContainer).toHaveBeenCalledWith(CONTAINER, ["mkdir", "-p", "/tmp/newdir"]);
  });

  it("mkdir throws on non-zero exit", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from("Permission denied"),
    });

    const ops = createDockerWriteOps(CONTAINER);
    await expect(ops.mkdir("/restricted/newdir")).rejects.toThrow("mkdir failed: Permission denied");
  });
});

// ---------------------------------------------------------------------------
// EditOperations (delegates to read + write)
// ---------------------------------------------------------------------------

describe("createDockerEditOps", () => {
  it("delegates readFile to ReadOperations", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from("content\n"),
      stderr: Buffer.from(""),
    });

    const ops = createDockerEditOps(CONTAINER);
    const result = await ops.readFile("/path/file.txt");

    expect(mockExecInContainer).toHaveBeenCalledWith(CONTAINER, ["cat", "/path/file.txt"]);
    expect(result.toString()).toBe("content\n");
  });

  it("delegates writeFile to WriteOperations", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    });

    const ops = createDockerEditOps(CONTAINER);
    await ops.writeFile("/path/file.txt", "new content");

    expect(mockExecInContainer).toHaveBeenCalled();
    const [, cmdArgs] = mockExecInContainer.mock.calls[0];
    expect(cmdArgs).toContain("bash");
  });

  it("delegates access to ReadOperations", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    });

    const ops = createDockerEditOps(CONTAINER);
    await ops.access("/path/file.txt");

    expect(mockExecInContainer).toHaveBeenCalledWith(CONTAINER, ["test", "-r", "/path/file.txt"]);
  });
});

// ---------------------------------------------------------------------------
// BashOperations
// ---------------------------------------------------------------------------

describe("createDockerBashOps", () => {
  it("exec calls execInContainer with bash -c and returns exit code", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    });

    const ops = createDockerBashOps(CONTAINER);
    const result = await ops.exec("ls -la", "/workspace", {
      onData: vi.fn(),
      signal: undefined,
      timeout: undefined,
      env: {},
    });

    expect(mockExecInContainer).toHaveBeenCalledWith(
      CONTAINER,
      ["bash", "-c", "ls -la"],
      { cwd: "/workspace", onData: expect.any(Function), signal: undefined, timeout: undefined },
    );
    expect(result).toEqual({ exitCode: 0 });
  });

  it("ignores host env to prevent leakage", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    });

    const ops = createDockerBashOps(CONTAINER);
    // Pass host env (including host PATH) — should be ignored
    await ops.exec("echo hi", "/", {
      onData: vi.fn(),
      signal: undefined,
      timeout: undefined,
      env: { PATH: "/host/bin:/usr/bin", SECRET: "should-not-leak" },
    });

    // The commmand should NOT have any env exports prepended
    const [, cmdArgs] = mockExecInContainer.mock.calls[0];
    expect(cmdArgs).toEqual(["bash", "-c", "echo hi"]);
  });

  it("forwards onData, signal, timeout", async () => {
    const onData = vi.fn();
    const signal = new AbortController().signal;
    mockExecInContainer.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    });

    const ops = createDockerBashOps(CONTAINER);
    await ops.exec("long-task", "/tmp", { onData, signal, timeout: 30, env: {} });

    expect(mockExecInContainer).toHaveBeenCalledWith(
      CONTAINER,
      ["bash", "-c", "long-task"],
      { cwd: "/tmp", onData, signal, timeout: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// LsOperations
// ---------------------------------------------------------------------------

describe("createDockerLsOps", () => {
  it("exists returns true when test -e succeeds", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    });

    const ops = createDockerLsOps(CONTAINER);
    const result = await ops.exists("/tmp");

    expect(mockExecInContainer).toHaveBeenCalledWith(CONTAINER, ["test", "-e", "/tmp"]);
    expect(result).toBe(true);
  });

  it("exists returns false when test -e fails", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    });

    const ops = createDockerLsOps(CONTAINER);
    const result = await ops.exists("/nonexistent");
    expect(result).toBe(false);
  });

  it("stat returns an object with isDirectory()", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from("directory\n"),
      stderr: Buffer.from(""),
    });

    const ops = createDockerLsOps(CONTAINER);
    const result = await ops.stat("/tmp");

    expect(mockExecInContainer).toHaveBeenCalledWith(CONTAINER, [
      "stat", "--format=%F", "/tmp",
    ]);
    expect(result.isDirectory()).toBe(true);
  });

  it("stat returns isDirectory() = false for files", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from("regular file\n"),
      stderr: Buffer.from(""),
    });

    const ops = createDockerLsOps(CONTAINER);
    const result = await ops.stat("/tmp/file.txt");
    expect(result.isDirectory()).toBe(false);
  });

  it("stat throws on error", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from("stat: cannot stat"),
    });

    const ops = createDockerLsOps(CONTAINER);
    await expect(ops.stat("/bogus")).rejects.toThrow("stat failed: stat: cannot stat");
  });

  it("readdir splits ls output into lines", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from("file1\nfile2\nfile3\n"),
      stderr: Buffer.from(""),
    });

    const ops = createDockerLsOps(CONTAINER);
    const result = await ops.readdir("/tmp");

    expect(mockExecInContainer).toHaveBeenCalledWith(CONTAINER, ["ls", "-1", "/tmp"]);
    expect(result).toEqual(["file1", "file2", "file3"]);
  });

  it("readdir returns empty array for empty directory", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    });

    const ops = createDockerLsOps(CONTAINER);
    const result = await ops.readdir("/empty");
    expect(result).toEqual([]);
  });

  it("readdir throws on error", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from("Permission denied"),
    });

    const ops = createDockerLsOps(CONTAINER);
    await expect(ops.readdir("/root")).rejects.toThrow("readdir failed: Permission denied");
  });
});

// ---------------------------------------------------------------------------
// GrepOperations
// ---------------------------------------------------------------------------

describe("createDockerGrepOps", () => {
  it("isDirectory returns true when test -d succeeds", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    });

    const ops = createDockerGrepOps(CONTAINER);
    const result = await ops.isDirectory("/tmp");

    expect(mockExecInContainer).toHaveBeenCalledWith(CONTAINER, ["test", "-d", "/tmp"]);
    expect(result).toBe(true);
  });

  it("isDirectory returns false when test -d fails", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    });

    const ops = createDockerGrepOps(CONTAINER);
    const result = await ops.isDirectory("/tmp/file.txt");
    expect(result).toBe(false);
  });

  it("readFile returns string content", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from("line1\nline2\n"),
      stderr: Buffer.from(""),
    });

    const ops = createDockerGrepOps(CONTAINER);
    const result = await ops.readFile("/tmp/file.txt");

    expect(mockExecInContainer).toHaveBeenCalledWith(CONTAINER, ["cat", "/tmp/file.txt"]);
    expect(result).toBe("line1\nline2\n");
  });

  it("readFile throws on error", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from("No such file"),
    });

    const ops = createDockerGrepOps(CONTAINER);
    await expect(ops.readFile("/nonexistent")).rejects.toThrow(
      "readFile for grep failed: No such file",
    );
  });
});

// ---------------------------------------------------------------------------
// FindOperations
// ---------------------------------------------------------------------------

describe("createDockerFindOps", () => {
  it("exists returns true when test -e succeeds", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    });

    const ops = createDockerFindOps(CONTAINER);
    const result = await ops.exists("/tmp");

    expect(mockExecInContainer).toHaveBeenCalledWith(CONTAINER, ["test", "-e", "/tmp"]);
    expect(result).toBe(true);
  });

  it("glob uses find -name and returns absolute paths", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from("./src/index.ts\n./src/docker.ts\n"),
      stderr: Buffer.from(""),
    });

    const ops = createDockerFindOps(CONTAINER);
    const result = await ops.glob("*.ts", "/workspace", { ignore: ["node_modules"], limit: 100 });

    expect(mockExecInContainer).toHaveBeenCalledWith(
      CONTAINER,
      [
        "bash", "-c",
        'find . -type f -name "*.ts" -not -path \'./node_modules\' -print | head -100',
      ],
      { cwd: "/workspace" },
    );
    expect(result).toEqual(["/workspace/src/index.ts", "/workspace/src/docker.ts"]);
  });

  it("glob returns empty array for no matches", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    });

    const ops = createDockerFindOps(CONTAINER);
    const result = await ops.glob("*.nonexistent", "/tmp", { ignore: [], limit: 100 });
    expect(result).toEqual([]);
  });

  it("glob throws on error", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from("find: error"),
    });

    const ops = createDockerFindOps(CONTAINER);
    await expect(ops.glob("*.ts", "/bad", { ignore: [], limit: 100 })).rejects.toThrow(
      "glob failed: find: error",
    );
  });

  it("glob with multiple ignore patterns", async () => {
    mockExecInContainer.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from("./src/index.ts\n"),
      stderr: Buffer.from(""),
    });

    const ops = createDockerFindOps(CONTAINER);
    const result = await ops.glob("*.ts", "/workspace", {
      ignore: ["node_modules", "dist"],
      limit: 100,
    });

    expect(mockExecInContainer).toHaveBeenCalledWith(
      CONTAINER,
      [
        "bash", "-c",
        'find . -type f -name "*.ts" -not -path \'./node_modules\' -not -path \'./dist\' -print | head -100',
      ],
      { cwd: "/workspace" },
    );
    expect(result).toEqual(["/workspace/src/index.ts"]);
  });

  it("respects limit parameter", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `./file${i}.ts\n`).join("");
    mockExecInContainer.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from(lines),
      stderr: Buffer.from(""),
    });

    const ops = createDockerFindOps(CONTAINER);
    const result = await ops.glob("*.ts", "/workspace", { ignore: [], limit: 5 });

    // The head -5 should have been applied inside the container
    expect(mockExecInContainer).toHaveBeenCalledWith(
      CONTAINER,
      [
        "bash", "-c",
        'find . -type f -name "*.ts"  -print | head -5',
      ],
      { cwd: "/workspace" },
    );
    expect(result).toHaveLength(50); // We're just testing the piping, the mock returns all 50
  });
});
