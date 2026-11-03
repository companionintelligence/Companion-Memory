#include "CiPowerSyncCore.h"

/* Declared here rather than through a header so this file needs no header search path into
   the SQLCipher pod; both symbols resolve at link time, from SQLCipher and from
   powersync-sqlite-core (see the podspec). Same call as @powersync/capacitor's
   register_powersync(). */
extern int sqlite3_auto_extension(void (*xEntryPoint)(void));
extern int sqlite3_powersync_init(void *db, const char **pzErrMsg, const void *pApi);

int ci_register_powersync_core(void) {
    return sqlite3_auto_extension((void (*)(void))sqlite3_powersync_init);
}
