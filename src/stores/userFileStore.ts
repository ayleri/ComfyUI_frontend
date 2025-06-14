import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { UserDataFullInfo } from '@/schemas/apiSchema'
import { api } from '@/scripts/api'
import { TreeExplorerNode } from '@/types/treeExplorerTypes'
import { getPathDetails } from '@/utils/formatUtil'
import { syncEntities, syncEntitiesV2 } from '@/utils/syncUtil'
import { buildTree } from '@/utils/treeUtil'

/**
 * Represents a file in the user's data directory.
 */
export class UserFile {
  /**
   * Various path components.
   * Example:
   * - path: 'dir/file.txt'
   * - directory: 'dir'
   * - fullFilename: 'file.txt'
   * - filename: 'file'
   * - suffix: 'txt'
   */
  directory: string
  fullFilename: string
  filename: string
  suffix: string | null

  isLoading: boolean = false
  content: string | null = null
  originalContent: string | null = null

  constructor(
    /**
     * Path relative to ComfyUI/user/ directory.
     */
    public path: string,
    /**
     * Last modified timestamp.
     */
    public lastModified: number,
    /**
     * File size in bytes. -1 for temporary files.
     */
    public size: number
  ) {
    const details = getPathDetails(path)
    this.path = path
    this.directory = details.directory
    this.fullFilename = details.fullFilename
    this.filename = details.filename
    this.suffix = details.suffix
  }

  updatePath(newPath: string) {
    const details = getPathDetails(newPath)
    this.path = newPath
    this.directory = details.directory
    this.fullFilename = details.fullFilename
    this.filename = details.filename
    this.suffix = details.suffix
  }

  static createTemporary(path: string): UserFile {
    return new UserFile(path, Date.now(), -1)
  }

  get isTemporary() {
    return this.size === -1
  }

  get isPersisted() {
    return !this.isTemporary
  }

  get key(): string {
    return this.path
  }

  get isLoaded() {
    return this.content !== null
  }

  get isModified() {
    return this.content !== this.originalContent
  }

  /**
   * Loads the file content from the remote storage.
   */
  async load({
    force = false
  }: { force?: boolean } = {}): Promise<LoadedUserFile> {
    if (this.isTemporary || (!force && this.isLoaded))
      return this as LoadedUserFile

    this.isLoading = true
    const resp = await api.getUserData(this.path)
    if (resp.status !== 200) {
      throw new Error(
        `Failed to load file '${this.path}': ${resp.status} ${resp.statusText}`
      )
    }
    this.content = await resp.text()
    this.originalContent = this.content
    this.isLoading = false
    return this as LoadedUserFile
  }

  /**
   * Unloads the file content from memory
   */
  unload(): void {
    this.content = null
    this.originalContent = null
    this.isLoading = false
  }

  async saveAs(newPath: string): Promise<UserFile> {
    const tempFile = this.isTemporary ? this : UserFile.createTemporary(newPath)
    tempFile.content = this.content
    await tempFile.save()
    return tempFile
  }

  /**
   * Saves the file to the remote storage.
   * @param force Whether to force the save even if the file is not modified.
   */
  async save({ force = false }: { force?: boolean } = {}): Promise<UserFile> {
    if (this.isPersisted && !this.isModified && !force) return this

    const resp = await api.storeUserData(this.path, this.content, {
      overwrite: this.isPersisted,
      throwOnError: true,
      full_info: true
    })

    // Note: Backend supports full_info=true feature after
    // https://github.com/comfyanonymous/ComfyUI/pull/5446
    const updatedFile = (await resp.json()) as string | UserDataFullInfo
    if (typeof updatedFile === 'object') {
      this.lastModified = updatedFile.modified
      this.size = updatedFile.size
    }
    this.originalContent = this.content
    return this
  }

  async delete(): Promise<void> {
    if (this.isTemporary) return

    const resp = await api.deleteUserData(this.path)
    if (resp.status !== 204) {
      throw new Error(
        `Failed to delete file '${this.path}': ${resp.status} ${resp.statusText}`
      )
    }
  }

  async rename(newPath: string): Promise<UserFile> {
    if (this.isTemporary) {
      this.updatePath(newPath)
      return this
    }

    const resp = await api.moveUserData(this.path, newPath)
    if (resp.status !== 200) {
      throw new Error(
        `Failed to rename file '${this.path}': ${resp.status} ${resp.statusText}`
      )
    }
    this.updatePath(newPath)
    // Note: Backend supports full_info=true feature after
    // https://github.com/comfyanonymous/ComfyUI/pull/5446
    const updatedFile = (await resp.json()) as string | UserDataFullInfo
    if (typeof updatedFile === 'object') {
      this.lastModified = updatedFile.modified
      this.size = updatedFile.size
    }
    return this
  }
}

export interface LoadedUserFile extends UserFile {
  isLoaded: true
  originalContent: string
  content: string
}

export const useUserFileStore = defineStore('userFile', () => {
  const userFilesByPath = ref<Record<string, UserFile>>({})
  // Track empty directories for user data
  const userDirs = ref<Set<string>>(new Set())

  const userFiles = computed(() => Object.values(userFilesByPath.value))
  const modifiedFiles = computed(() =>
    userFiles.value.filter((file: UserFile) => file.isModified)
  )
  const loadedFiles = computed(() =>
    userFiles.value.filter((file: UserFile) => file.isLoaded)
  )

  const fileTree = computed<TreeExplorerNode<UserFile>>(() => {
    const entries: { path: string; isDir: boolean; file?: UserFile }[] = []
    // directory entries (empty-folder support)
    for (const dirPath of userDirs.value) {
      entries.push({ path: dirPath, isDir: true })
    }
    // file entries
    for (const file of userFiles.value) {
      entries.push({ path: file.path, isDir: false, file })
    }
    return (
      buildTree(entries as any, (item: any) => {
        const segs = item.path.split('/')
        return item.isDir ? [...segs, ''] : segs
      }) as TreeExplorerNode<UserFile>
    )
  })

  /**
   * Syncs the files in the given directory with the API.
   * @param dir The directory to sync.
   */
  const syncFiles = async (dir: string = '') => {
    // List files and directories via v2 endpoint
    await syncEntitiesV2(
      dir,
      userFilesByPath.value,
      (entry) => new UserFile(entry.path, entry.modified ?? 0, entry.size ?? 0),
      (existingFile, entry) => {
        existingFile.lastModified = entry.modified ?? existingFile.lastModified
        existingFile.size = entry.size ?? existingFile.size
        existingFile.unload()
      },
      () => false,
      userDirs.value
    )
  }

  return {
    userFiles,
    modifiedFiles,
    loadedFiles,
    fileTree,
    syncFiles
  }
})
