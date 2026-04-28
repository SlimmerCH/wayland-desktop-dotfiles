#pragma once
#include <glib-object.h>

G_BEGIN_DECLS

#define KIWI_TYPE_SHORTCUTS_MANAGER (kiwi_shortcuts_manager_get_type())
G_DECLARE_FINAL_TYPE(KiwiShortcutsManager, kiwi_shortcuts_manager, KIWI, SHORTCUTS_MANAGER, GObject)

KiwiShortcutsManager *kiwi_shortcuts_manager_new      (void);
void                  kiwi_shortcuts_manager_register (KiwiShortcutsManager *self,
                                                        const char           *id,
                                                        const char           *description);

G_END_DECLS
