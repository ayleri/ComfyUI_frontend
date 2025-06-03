import { api } from '@/scripts/api'

/**
 * Sync entities from the API to the entityByPath map.
 * @param dir The directory to sync from
 * @param entityByPath The map to sync to
 * @param createEntity A function to create an entity from a file
 * @param updateEntity A function to update an entity from a file
 * @param exclude A function to exclude an entity
 */
export async function syncEntities<T>(
  dir: string,
  entityByPath: Record<string, T>,
  createEntity: (file: any) => T,
  updateEntity: (entity: T, file: any) => void,
  exclude: (file: T) => boolean = () => false
) {
  const files = (await api.listUserDataFullInfo(dir)).map((file) => ({
    ...file,
    path: dir ? `${dir}/${file.path}` : file.path
  }))

  for (const file of files) {
    const existingEntity = entityByPath[file.path]

    if (!existingEntity) {
      // New entity, add it to the map
      entityByPath[file.path] = createEntity(file)
    } else if (exclude(existingEntity)) {
      // Entity has been excluded, skip it
      continue
    } else {
      // Entity has been modified, update its properties
      updateEntity(existingEntity, file)
    }
  }

  // Remove entities that no longer exist
  for (const [path, entity] of Object.entries(entityByPath)) {
    if (exclude(entity)) continue
    if (!files.some((file) => file.path === path)) {
      delete entityByPath[path]
    }
  }
}

/**
 * Sync entities using the /v2/userdata endpoint, including tracking empty directories.
 * @param path The relative path within the user's data directory to list.
 * @param entityByPath Map of existing entities keyed by full relative path.
 * @param createEntity Function to create a new entity from a v2 entry.
 * @param updateEntity Function to update an existing entity from a v2 entry.
 * @param exclude Optional filter to exclude entities (e.g. temporary items).
 * @param dirSet Optional Set to collect directory paths for empty-folder support.
 */
export async function syncEntitiesV2<T>(
  path: string,
  entityByPath: Record<string, T>,
  createEntity: (entry: any) => T,
  updateEntity: (entity: T, entry: any) => void,
  exclude: (entity: T) => boolean = () => false,
  dirSet?: Set<string>
) {
  // Fetch structured listing (files and directories)
  const entries = await api.listUserDataV2(path)

  // Track directories if requested
  if (dirSet) {
    dirSet.clear()
    for (const e of entries) {
      if (e.type === 'directory') {
        dirSet.add(e.path)
      }
    }
  }

  // Process file entries
  const files = entries.filter((e) => e.type === 'file')
  // Add or update entities
  for (const fileEntry of files) {
    const key = fileEntry.path
    const existing = entityByPath[key]
    if (!existing) {
      entityByPath[key] = createEntity(fileEntry)
    } else if (!exclude(existing)) {
      updateEntity(existing, fileEntry)
    }
  }

  // Remove entities no longer present
  for (const p of Object.keys(entityByPath)) {
    const ent = entityByPath[p]
    if (exclude(ent)) {
      continue
    }
    if (!files.some((e) => e.path === p)) {
      delete entityByPath[p]
    }
  }
}
