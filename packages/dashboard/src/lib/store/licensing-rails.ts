import { z } from 'zod';

export const licensingRailsSchema = z.object({
  runtimeLicensing: z.boolean(),
  downloadableFiles: z.boolean(),
  hostedAccess: z.boolean(),
  discordRoles: z.boolean(),
  updates: z.boolean(),
});

export type LicensingRails = z.infer<typeof licensingRailsSchema>;

export const DYNAMIC_DEFAULT_RAILS = {
  runtimeLicensing: true,
  downloadableFiles: false,
  hostedAccess: false,
  discordRoles: false,
  updates: false,
} satisfies LicensingRails;

export const STATIC_DEFAULT_RAILS = {
  runtimeLicensing: false,
  downloadableFiles: true,
  hostedAccess: false,
  discordRoles: false,
  updates: false,
} satisfies LicensingRails;
