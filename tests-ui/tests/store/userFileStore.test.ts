import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/scripts/api'
import { UserFile, useUserFileStore } from '@/stores/userFileStore'

// Mock the api
vi.mock('@/scripts/api', () => ({
  api: {
    listUserDataV2: vi.fn(),
    listUserDataFullInfo: vi.fn(),
    getUserData: vi.fn(),
    storeUserData: vi.fn(),
    deleteUserData: vi.fn(),
    moveUserData: vi.fn()
  }
}))

describe('useUserFileStore', () => {
  let store: ReturnType<typeof useUserFileStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    store = useUserFileStore()
    vi.resetAllMocks()
  })

  it('should initialize with empty files', () => {
    expect(store.userFiles).toHaveLength(0)
    expect(store.modifiedFiles).toHaveLength(0)
    expect(store.loadedFiles).toHaveLength(0)
  })

  describe('syncFiles', () => {
    it('should add new files and track directories', async () => {
      const entries = [
        { name: 'file1.txt', path: 'dir/file1.txt', type: 'file', size: 100, modified: 123 },
        { name: 'subdir', path: 'dir/subdir', type: 'directory' }
      ]
      vi.mocked(api.listUserDataV2).mockResolvedValue(entries)

      await store.syncFiles('dir')

      expect(store.userFiles).toHaveLength(1)
      expect(store.userFiles[0].path).toBe('dir/file1.txt')
      // directory entry should be tracked internally (via fileTree)
      const tree = store.fileTree
      expect(tree.children?.some((n) => n.key.endsWith('/subdir') && !n.leaf)).toBe(true)
    })

    it('should update existing files', async () => {
      const initial = [{ name: 'f.txt', path: 'd/f.txt', type: 'file', size: 10, modified: 1 }]
      vi.mocked(api.listUserDataV2).mockResolvedValue(initial)
      await store.syncFiles('d')

      const updated = [{ name: 'f.txt', path: 'd/f.txt', type: 'file', size: 20, modified: 2 }]
      vi.mocked(api.listUserDataV2).mockResolvedValue(updated)
      await store.syncFiles('d')

      expect(store.userFiles[0].lastModified).toBe(2)
      expect(store.userFiles[0].size).toBe(20)
    })

    it('should remove non-existent files', async () => {
      const initial = [
        { name: 'a', path: 'd/a', type: 'file', size: 1, modified: 1 },
        { name: 'b', path: 'd/b', type: 'file', size: 1, modified: 1 }
      ]
      vi.mocked(api.listUserDataV2).mockResolvedValue(initial)
      await store.syncFiles('d')

      const updated = [{ name: 'a', path: 'd/a', type: 'file', size: 1, modified: 1 }]
      vi.mocked(api.listUserDataV2).mockResolvedValue(updated)
      await store.syncFiles('d')

      expect(store.userFiles).toHaveLength(1)
      expect(store.userFiles[0].path).toBe('d/a')
    })

    it('should list root when no dir specified', async () => {
      const entries = [{ name: 'root.txt', path: 'root.txt', type: 'file', size: 5, modified: 5 }]
      vi.mocked(api.listUserDataV2).mockResolvedValue(entries)

      await store.syncFiles()

      expect(api.listUserDataV2).toHaveBeenCalledWith('')
      expect(store.userFiles).toHaveLength(1)
      expect(store.userFiles[0].path).toBe('root.txt')
    })
  })

  describe('UserFile', () => {
    describe('load', () => {
      it('should load file content', async () => {
        const file = new UserFile('file1.txt', 123, 100)
        vi.mocked(api.getUserData).mockResolvedValue({
          status: 200,
          text: () => Promise.resolve('file content')
        } as Response)

        await file.load()

        expect(file.content).toBe('file content')
        expect(file.originalContent).toBe('file content')
        expect(file.isLoading).toBe(false)
        expect(file.isLoaded).toBe(true)
      })

      it('should throw error on failed load', async () => {
        const file = new UserFile('file1.txt', 123, 100)
        vi.mocked(api.getUserData).mockResolvedValue({
          status: 404,
          statusText: 'Not Found'
        } as Response)

        await expect(file.load()).rejects.toThrow(
          "Failed to load file 'file1.txt': 404 Not Found"
        )
      })
    })

    describe('save', () => {
      it('should save modified file', async () => {
        const file = new UserFile('file1.txt', 123, 100)
        file.content = 'modified content'
        file.originalContent = 'original content'
        vi.mocked(api.storeUserData).mockResolvedValue({
          status: 200,
          json: () => Promise.resolve({ modified: 456, size: 200 })
        } as Response)

        await file.save()

        expect(api.storeUserData).toHaveBeenCalledWith(
          'file1.txt',
          'modified content',
          { throwOnError: true, full_info: true, overwrite: true }
        )
        expect(file.lastModified).toBe(456)
        expect(file.size).toBe(200)
      })

      it('should not save unmodified file', async () => {
        const file = new UserFile('file1.txt', 123, 100)
        file.content = 'content'
        file.originalContent = 'content'

        await file.save()

        expect(api.storeUserData).not.toHaveBeenCalled()
      })
    })

    describe('delete', () => {
      it('should delete file', async () => {
        const file = new UserFile('file1.txt', 123, 100)
        vi.mocked(api.deleteUserData).mockResolvedValue({
          status: 204
        } as Response)

        await file.delete()

        expect(api.deleteUserData).toHaveBeenCalledWith('file1.txt')
      })
    })

    describe('rename', () => {
      it('should rename file', async () => {
        const file = new UserFile('file1.txt', 123, 100)
        vi.mocked(api.moveUserData).mockResolvedValue({
          status: 200,
          json: () => Promise.resolve({ modified: 456, size: 200 })
        } as Response)

        await file.rename('newfile.txt')

        expect(api.moveUserData).toHaveBeenCalledWith(
          'file1.txt',
          'newfile.txt'
        )
        expect(file.path).toBe('newfile.txt')
        expect(file.lastModified).toBe(456)
        expect(file.size).toBe(200)
      })
    })

    describe('saveAs', () => {
      it('should save file with new path', async () => {
        const file = new UserFile('file1.txt', 123, 100)
        file.content = 'file content'
        vi.mocked(api.storeUserData).mockResolvedValue({
          status: 200,
          json: () => Promise.resolve({ modified: 456, size: 200 })
        } as Response)

        const newFile = await file.saveAs('newfile.txt')

        expect(api.storeUserData).toHaveBeenCalledWith(
          'newfile.txt',
          'file content',
          // SaveAs should create a new temporary file, which will mean
          // overwrite is false
          { throwOnError: true, full_info: true, overwrite: false }
        )
        expect(newFile).toBeInstanceOf(UserFile)
        expect(newFile.path).toBe('newfile.txt')
        expect(newFile.lastModified).toBe(456)
        expect(newFile.size).toBe(200)
        expect(newFile.content).toBe('file content')
      })
    })
  })
})
