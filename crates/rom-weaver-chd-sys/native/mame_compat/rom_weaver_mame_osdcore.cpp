#include "osdcore.h"

#include <chrono>
#include <thread>

struct osd_work_queue
{
    int flags;
    int pending;
};

struct osd_work_item
{
    void *result;
    bool complete;
};

osd_ticks_t osd_ticks() noexcept
{
    using namespace std::chrono;
    return static_cast<osd_ticks_t>(duration_cast<nanoseconds>(steady_clock::now().time_since_epoch()).count());
}

osd_ticks_t osd_ticks_per_second() noexcept
{
    return 1'000'000'000ULL;
}

void osd_sleep(osd_ticks_t duration) noexcept
{
    std::this_thread::sleep_for(std::chrono::nanoseconds(duration));
}

osd_work_queue *osd_work_queue_alloc(int flags)
{
    return new osd_work_queue{flags, 0};
}

int osd_work_queue_items(osd_work_queue *queue)
{
    return queue ? queue->pending : 0;
}

bool osd_work_queue_wait(osd_work_queue *, osd_ticks_t)
{
    return true;
}

void osd_work_queue_free(osd_work_queue *queue)
{
    delete queue;
}

osd_work_item *osd_work_item_queue_multiple(
    osd_work_queue *queue,
    osd_work_callback callback,
    int32_t numitems,
    void *parambase,
    int32_t paramstep,
    uint32_t flags
)
{
    osd_work_item *last = nullptr;
    auto *param = static_cast<unsigned char *>(parambase);
    for (int32_t index = 0; index < numitems; ++index)
    {
        if (queue)
            ++queue->pending;
        last = new osd_work_item{nullptr, false};
        last->result = callback(param, 0);
        last->complete = true;
        if (queue)
            --queue->pending;
        param += paramstep;
        if (flags & WORK_ITEM_FLAG_AUTO_RELEASE)
        {
            delete last;
            last = nullptr;
        }
    }
    return last;
}

bool osd_work_item_wait(osd_work_item *item, osd_ticks_t)
{
    return !item || item->complete;
}

void *osd_work_item_result(osd_work_item *item)
{
    return item ? item->result : nullptr;
}

void osd_work_item_release(osd_work_item *item)
{
    delete item;
}
