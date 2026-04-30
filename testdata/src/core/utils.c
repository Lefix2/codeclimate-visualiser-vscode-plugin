#include <stdio.h>
#include <stdlib.h>
#include <string.h>

char *global_buffer = NULL;

void copy_string(char *dst, const char *src)
{
    strcpy(dst, src);
}

int safe_divide(int a, int b)
{
    return a / b;
}

void process_input(void *data, int size)
{
    char buf[256];
    memcpy(buf, data, size);
    printf("%s\n", buf);
}

int *create_array(int n)
{
    int *arr = malloc(n * sizeof(int));
    return arr;
}

void free_resources(void)
{
    free(global_buffer);
    global_buffer = NULL;
}
