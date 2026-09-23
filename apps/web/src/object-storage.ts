import {
  createControlledFileStorage,
  storageConfiguration,
  type ControlledFileStorage,
} from "@policyoffice/storage";

let storage: ControlledFileStorage | undefined;

/** The web process shares one client behind the package's only construction seam. */
export function controlledFileStorage(): ControlledFileStorage {
  storage ??= createControlledFileStorage(storageConfiguration());
  return storage;
}
