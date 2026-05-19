import type { API } from 'homebridge';
import { PLATFORM_NAME } from './settings.js';
import { AcHttpPlatform } from './platform.js';

export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, AcHttpPlatform);
};
