// Minimal queue/timing interfaces required by the embedded MAME CHD subset.
#ifndef ROM_WEAVER_MAME_COMPAT_OSDCORE_H
#define ROM_WEAVER_MAME_COMPAT_OSDCORE_H

#include "osdcomm.h"

#include <cstdint>

typedef uint64_t osd_ticks_t;

osd_ticks_t osd_ticks() noexcept;
osd_ticks_t osd_ticks_per_second() noexcept;
void osd_sleep(osd_ticks_t duration) noexcept;

#define WORK_MAX_THREADS 16
#define WORK_QUEUE_FLAG_IO 0x0001
#define WORK_QUEUE_FLAG_MULTI 0x0002
#define WORK_QUEUE_FLAG_HIGH_FREQ 0x0004
#define WORK_ITEM_FLAG_AUTO_RELEASE 0x0001

struct osd_work_queue;
struct osd_work_item;
typedef void *(*osd_work_callback)(void *param, int threadid);

osd_work_queue *osd_work_queue_alloc(int flags);
int osd_work_queue_items(osd_work_queue *queue);
bool osd_work_queue_wait(osd_work_queue *queue, osd_ticks_t timeout);
void osd_work_queue_free(osd_work_queue *queue);
osd_work_item *osd_work_item_queue_multiple(
    osd_work_queue *queue,
    osd_work_callback callback,
    int32_t numitems,
    void *parambase,
    int32_t paramstep,
    uint32_t flags
);
static inline osd_work_item *osd_work_item_queue(osd_work_queue *queue, osd_work_callback callback, void *param, uint32_t flags)
{
    return osd_work_item_queue_multiple(queue, callback, 1, param, 0, flags);
}
bool osd_work_item_wait(osd_work_item *item, osd_ticks_t timeout);
void *osd_work_item_result(osd_work_item *item);
void osd_work_item_release(osd_work_item *item);

// CHD bridge controls the worker count for WORK_QUEUE_FLAG_MULTI queues.
extern "C" void rw_mame_chd_set_thread_count(int thread_count) noexcept;

#endif
