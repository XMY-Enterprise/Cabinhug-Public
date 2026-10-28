/**
 * 车辆建档的共享逻辑（两端共用）。
 *
 * 共用的理由：FL-23 规定"手机端支持扫码 VIN 或手动录入，**车机和 Web 仅支持
 * 手动录入**"——车机端同样要建档。目录与校验规则各写一份必然漂移，
 * 漂移会让同一辆车在两个端建出车型名不同的两条档案，检索侧对不上。
 *
 * 这里只放**纯逻辑**（目录数据 + 步进校验 + 请求体组装）：
 * 两端的 UI 差异很大（触控 44px vs 车机 48px、单列 vs 分区），组件不共享。
 */

export {
  catalogBrands,
  catalogFromResponse,
  catalogYears,
  entryOf,
  knowledgeNote,
  modelsOfBrand,
  offlineCatalog,
  searchCatalog,
  type CatalogResponse,
  type CatalogView,
  type KnowledgeCoverageState,
  type ModelKnowledgeLink,
  type VehicleCatalogEntry,
} from "./catalog";

export {
  inferPersonGender,
  personArtKey,
  type CharacterGender,
  type PersonArtKey,
} from "./person-art-match";

export {
  characterInitial,
  personCharacter,
  vehicleCharacter,
  vehicleDoorOpenCharacter,
  vehicleLitCharacter,
  vehicleRearCharacter,
  type CharacterTheme,
} from "./profile-characters";

export {
  ENERGY_CHOICES,
  WIZARD_STEPS,
  validateStep,
  draftToCreateBody,
  type EnergyChoice,
  type WizardDraft,
} from "./wizard-logic";
export * from "./departure-clips";
export { createClipCache, type ClipCache, type ClipCacheIo } from "./departure-clip-cache";
